const nconf = require('nconf');
const emoji = require('node-emoji');
const axios = require('axios');

nconf.argv().env().file({ file: './ethNotifier.json' });

const {
    getNewBlocks,
    getProposerDuties,
    getCachedCommittees,
    getAttestationDuties,
    getAttestations,
    getBeaconWithdrawals,
    LIGHTHOUSE_URL,
    cache
} = require('./lighthouse-api');

const all_validators = nconf.get('validators');
const batchSize = nconf.get('batchSize') || 100;
const pollingInterval = nconf.get('pollingInterval') || 60;
const epochsBeforeFinal = nconf.get('epochsBeforeFinal') || 1;
const telegramMethod = nconf.get('telegram:method') || 'bot-api';
const maxConcurrentRequests = nconf.get('maxConcurrentRequests') || 30;

// Validate required configuration
if (!all_validators || typeof all_validators !== 'object' || Object.keys(all_validators).length === 0) {
    console.error('✗ Error: "validators" configuration is missing or empty in ethNotifier.json');
    console.error('');
    console.error('Please add validators to your ethNotifier.json file:');
    console.error('{');
    console.error('  "validators": {');
    console.error('    "My Validators": [123456, 123457]');
    console.error('  }');
    console.error('}');
    process.exit(1);
}

// Load the appropriate Telegram module based on configuration
const telegramWrapper = telegramMethod === 'bot-api'
    ? require('./telegram-bot-api')
    : require('./telegram-wrapper');

console.log('Configuration loaded:');
console.log('  Batch size:', batchSize, 'slots per batch');
console.log('  Polling interval:', pollingInterval, 'seconds');
console.log('  Epochs before final:', epochsBeforeFinal, 'epoch(s)');
console.log('  Max concurrent requests:', maxConcurrentRequests);

(async function () {
    try {
        const response = await axios.get(`${LIGHTHOUSE_URL}/eth/v1/node/version`);
        console.log('✓ Connected to Lighthouse:', response.data.data.version);
    } catch (error) {
        console.error('✗ Cannot connect to Lighthouse:', error.message);
        process.exit(1);
    }
})();

function sendTelegramNotification(message, options) {
    console.log(message.replace(/<[^>]*>/g, ''));
    if (process.env.TEST_MODE !== 'true') {
        try {
            const promise = telegramWrapper.sendTelegramNotification(message, options);
            if (promise && typeof promise.catch === 'function') {
                promise.catch((error) => {
                    console.error('Error sending Telegram notification:', error.message);
                });
            }
        } catch (error) {
            console.error('Error sending Telegram notification:', error.message);
        }
    }
}

let lastBlock = parseInt(nconf.get('lastBlock'));
const sleep = (waitTimeInMs) => new Promise(resolve => setTimeout(resolve, waitTimeInMs));

// Pre-compute validator index to label lookup for O(1) performance
const validatorIndexToLabel = {};
for (const [label, validators] of Object.entries(all_validators)) {
    for (const validatorIndex of validators) {
        validatorIndexToLabel[validatorIndex] = label;
    }
}

// Helper function to get label for validator (O(1) lookup)
function getValidatorLabel(validatorIndex) {
    return validatorIndexToLabel[validatorIndex] || 'unknown';
}

// Helper function to process items in chunks with limited concurrency
async function processInChunks(items, processFn, chunkSize) {
    const results = [];
    for (let i = 0; i < items.length; i += chunkSize) {
        const chunk = items.slice(i, i + chunkSize);
        const chunkResults = await Promise.all(chunk.map(processFn));
        results.push(...chunkResults);
    }
    return results;
}

// Rate limiting for notifications (prevent spam)
const NOTIFICATION_RATE_LIMIT_INTERVAL = 30 * 60 * 1000; // 30 minutes in milliseconds
let lastStaleNodeNotification = 0;
let lastErrorNotification = 0;

(function () {
    console.log('');
    console.log('Starting Ethereum Validator Notifier');
    console.log('Lighthouse URL:', LIGHTHOUSE_URL);
    console.log('Starting from block:', lastBlock);
    console.log('');
    console.log('Monitoring validators:');

    for (const [label, validators] of Object.entries(all_validators)) {
        console.log(`  ${label}: [${validators.join(', ')}]`);
    }

    console.log('');
    console.log('Total validators:', Object.values(all_validators).flat().length);
    console.log('');
})();

async function mainLoop() {
    let missedAttestations = {};
    let submittedAttestations = {};
    let batchWithdrawals = {};

    const validatorsToMonitor = Object.values(all_validators).flat();

    try {
        // Get current head and calculate safe slot
        const headResponse = await axios.get(`${LIGHTHOUSE_URL}/eth/v1/beacon/headers/head`);
        const headSlot = parseInt(headResponse.data.data.header.message.slot);
        const headEpoch = Math.floor(headSlot / 32);
        const safeEpoch = Math.max(0, headEpoch - epochsBeforeFinal);
        const safeSlot = safeEpoch * 32;

        // Check if beacon node is stale (head slot is too far behind current time)
        // Genesis: 2020-12-01 12:00:23 UTC = 1606824023 seconds since epoch
        const GENESIS_TIME = 1606824023;
        const SECONDS_PER_SLOT = 12;
        const currentTimeSeconds = Math.floor(Date.now() / 1000);
        const expectedCurrentSlot = Math.floor((currentTimeSeconds - GENESIS_TIME) / SECONDS_PER_SLOT);
        const slotsBehind = expectedCurrentSlot - headSlot;

        // If head is more than 10 slots (2 minutes) behind, beacon node is likely stale
        if (slotsBehind > 10) {
            const now = Date.now();
            if (now - lastStaleNodeNotification >= NOTIFICATION_RATE_LIMIT_INTERVAL) {
                console.log(`⚠ WARNING: Beacon node is ${slotsBehind} slots (${Math.floor(slotsBehind * 12 / 60)} min) behind - Consensus Client may be stale`);
                sendTelegramNotification(
                    emoji.get('warning') + ` Beacon node is ${slotsBehind} slots behind - Consensus Client may be offline or stale`
                );
                lastStaleNodeNotification = now;
            }
        }

        console.log(`Current head: slot ${headSlot} (epoch ${headEpoch})`);
        if(safeSlot > lastBlock) console.log(`Safe to process: slot ${safeSlot} (epoch ${safeEpoch} - ${epochsBeforeFinal} epoch(s) behind head)`);

        const blocksToScanResult = await getNewBlocks(lastBlock);
        let blocksToScan = blocksToScanResult.rows;

        // Filter to only blocks within safe slot range
        blocksToScan = blocksToScan.filter(b => parseInt(b.f_slot) <= safeSlot);

        if (blocksToScan.length === 0) {
            // No blocks to process (either none found or all filtered out)
            await sleep(pollingInterval * 1000);
            mainLoop();
            return;
        }

        // Get the newest block after filtering
        const newestBlock = Math.min(
            parseInt(blocksToScan[blocksToScan.length - 1].f_slot),
            safeSlot
        );

        console.log(`Processing ${blocksToScan.length} blocks from slot ${lastBlock + 1} to ${newestBlock}`);

        const totalSlots = newestBlock - lastBlock;
        const numBatches = Math.ceil(totalSlots / batchSize);

        console.log(`Processing ${totalSlots} slots in ${numBatches} batch(es) of ${batchSize} slots each`);
        console.log('');

        // Save the initial starting point for batch calculations
        const initialStartSlot = lastBlock;

        // Process each batch
        for (let batchNum = 0; batchNum < numBatches; batchNum++) {
            const batchStartSlot = initialStartSlot + (batchNum * batchSize);
            const batchEndSlot = Math.min(batchStartSlot + batchSize, newestBlock);

            console.log(`[Batch ${batchNum + 1}/${numBatches}] Processing slots ${batchStartSlot + 1} to ${batchEndSlot}`);

            try {
                // ===== OPTIMIZATION: Query ONCE per batch for full range =====
                console.log(`[Batch ${batchNum + 1}/${numBatches}] Fetching data...`);

                // ===== OPTIMIZATION: Pre-fetch all committees in chunks =====
                // Both getAttestationDuties and getAttestations need committees for the same slots
                // Pre-fetching ensures cache is populated before both functions run
                // Attestations can appear in blocks up to 32 slots late
                // Process in chunks to avoid overwhelming the beacon node
                const slotsToFetch = [];
                for (let slot = batchStartSlot + 1; slot <= batchEndSlot + 32; slot++) {
                    slotsToFetch.push(slot);
                }

                // Fetch committees in chunks with limited concurrency
                const committeeResults = await processInChunks(
                    slotsToFetch,
                    (slot) => getCachedCommittees(slot).catch(() => null),
                    maxConcurrentRequests
                );

                const successCount = committeeResults.filter(c => c !== null).length;
                console.log(`[Batch ${batchNum + 1}/${numBatches}] Pre-fetched committees for ${successCount}/${slotsToFetch.length} slots`);

                const [proposerDutiesResult, attestationDutiesResult, attestationsResult, withdrawalsResult] = await Promise.all([
                    getProposerDuties(batchStartSlot, batchEndSlot, validatorsToMonitor),
                    getAttestationDuties(batchStartSlot, batchEndSlot, validatorsToMonitor),
                    getAttestations(batchStartSlot, batchEndSlot, validatorsToMonitor),
                    getBeaconWithdrawals(batchStartSlot, batchEndSlot, validatorsToMonitor)
                ]);

                const proposerDuties = proposerDutiesResult.rows;
                const attestationDuties = attestationDutiesResult.rows;
                const attestations = attestationsResult.rows;
                const withdrawals = withdrawalsResult.rows;

                console.log(`[Batch ${batchNum + 1}/${numBatches}] Found ${proposerDuties.length} proposer duties, ${attestationDuties.length} attestation duties, ${attestations.length} attestations, ${withdrawals.length} withdrawals`);

                // Build blocks lookup
                const blocksBySlot = {};
                for (const block of blocksToScan) {
                    blocksBySlot[parseInt(block.f_slot)] = block;
                }

                // Process proposer duties
                for (const duty of proposerDuties) {
                    const validatorIndex = parseInt(duty.f_validator_index);
                    const slot = parseInt(duty.f_slot);

                    const label = getValidatorLabel(validatorIndex);

                    const block = blocksBySlot[slot];

                    if (block && parseInt(block.f_proposer_index) === validatorIndex) {
                        const execBlockNumber = block.f_exec_block_number;
                        console.log(`✓ PROPOSED BLOCK ${execBlockNumber} AT SLOT ${slot} by validator ${validatorIndex} (${label})`);
                        sendTelegramNotification(
                            emoji.get('white_check_mark') + ' Validator <a href="https://beaconcha.in/validator/' + validatorIndex + '#blocks">' + validatorIndex + '</a> (<i>' + label + '</i>) proposed block '+ execBlockNumber + ' at slot <a href="https://beaconcha.in/slot/' + slot + '">' + slot + '</a>',
                            { parse_mode: "HTML", disable_web_page_preview: true }
                        );

                        // Check MEV reward (async, don't wait)
                        if (execBlockNumber) {
                            axios.get(`https://beaconcha.in/api/v1/execution/block/${execBlockNumber}`)
                                .then(response => {
                                    const data = response.data?.data?.[0];
                                    if (data?.blockMevReward && data.blockMevReward > 0) {
                                        const mevReward = (data.blockMevReward / 1e18).toFixed(5);
                                        sendTelegramNotification(
                                            emoji.get('moneybag') + ' MEV Reward for slot <a href="https://beaconcha.in/slot/' + slot + '">' + slot + '</a> (exec block ' + execBlockNumber + '): ' + mevReward + ' ETH',
                                            { parse_mode: "HTML", disable_web_page_preview: true }
                                        );
                                    } else {
                                        const dataStr = JSON.stringify(response.data, null, 2);
                                        sendTelegramNotification(
                                            emoji.get('heavy_exclamation_mark') + ' Could not retrieve MEV reward for slot <a href="https://beaconcha.in/slot/' + slot + '">' + slot + '</a> (exec block ' + execBlockNumber + ')\n\nResponse:\n<pre>' + dataStr + '</pre>',
                                            { parse_mode: "HTML", disable_web_page_preview: true }
                                        );
                                    }
                                })
                                .catch((error) => {
                                    console.error(`Error fetching MEV reward for slot ${slot} (exec block ${execBlockNumber}):`, error.message);
                                });
                        }
                    } else {
                        console.log(`✗ MISSED BLOCK PROPOSAL ${slot} by validator ${validatorIndex} (${label})`);
                        sendTelegramNotification(
                            emoji.get('x') + ' Validator <a href="https://beaconcha.in/validator/' + validatorIndex + '#blocks">' + validatorIndex + '</a> (<i>' + label + '</i>) failed to propose block at slot <a href="https://beaconcha.in/slot/' + slot + '">' + slot + '</a>',
                            { parse_mode: "HTML", disable_web_page_preview: true }
                        );
                    }
                }

                // Build attestations lookup by slot
                const attestationsBySlot = {};
                for (const attestation of attestations) {
                    const slot = parseInt(attestation.f_slot);
                    if (!attestationsBySlot[slot]) {
                        attestationsBySlot[slot] = [];
                    }
                    attestationsBySlot[slot].push(attestation);
                }

                // Process attestation duties
                for (const duty of attestationDuties) {
                    const slot = parseInt(duty.f_slot);
                    const committee = duty.f_committee;

                    // Find our validators in this committee
                    const ourValidators = committee.filter(v =>
                        validatorsToMonitor.includes(parseInt(v))
                    ).map(v => parseInt(v));

                    if (ourValidators.length === 0) continue;

                    // Get attestations FOR this slot
                    const attestationsForSlot = attestationsBySlot[slot] || [];

                    // Build set of validators who attested
                    const attestedValidators = new Set();
                    for (const attestation of attestationsForSlot) {
                        for (const vi of attestation.f_aggregation_indices) {
                            attestedValidators.add(parseInt(vi));
                        }
                    }

                    // Check each of our validators
                    for (const validatorIndex of ourValidators) {
                        if (attestedValidators.has(validatorIndex)) {
                            // Successfully attested
                            if (!submittedAttestations[validatorIndex]) {
                                submittedAttestations[validatorIndex] = [];
                            }
                            submittedAttestations[validatorIndex].push(slot);
                        } else {
                            // Missed attestation
                            console.log(`✗ MISSED ATTESTATION at slot ${slot} for validator ${validatorIndex}`);
                            if (!missedAttestations[validatorIndex]) {
                                missedAttestations[validatorIndex] = [];
                            }
                            missedAttestations[validatorIndex].push(slot);
                        }
                    }
                }

                // Process withdrawals
                for (const withdrawal of withdrawals) {
                    const validatorIndex = parseInt(withdrawal.f_validator_index);
                    const amount = withdrawal.f_amount;
                    const slot = withdrawal.f_slot;

                    const label = getValidatorLabel(validatorIndex);

                    console.log(`💸 WITHDRAWAL for validator ${validatorIndex} (${label}): ${amount} ETH at slot ${slot}`);

                    // Collect withdrawals for batch notification
                    if (!batchWithdrawals[validatorIndex]) {
                        batchWithdrawals[validatorIndex] = {
                            label: label,
                            withdrawals: [],
                            total: 0
                        };
                    }
                    batchWithdrawals[validatorIndex].withdrawals.push({
                        amount: amount,
                        slot: slot
                    });
                    batchWithdrawals[validatorIndex].total += amount;
                }

                console.log(`[Batch ${batchNum + 1}/${numBatches}] Processing complete`);

                // Send batch notifications for missed attestations
                const batchMissedCount = Object.keys(missedAttestations).length;
                if (batchMissedCount > 0) {
                    console.log(`[Batch ${batchNum + 1}/${numBatches}] Sending notifications for ${batchMissedCount} validator(s) with missed attestations`);

                    const missedByLabel = {};
                    for (const [validatorIndex, slots] of Object.entries(missedAttestations)) {
                        const vi = parseInt(validatorIndex);
                        const label = getValidatorLabel(vi);

                        if (!missedByLabel[label]) {
                            missedByLabel[label] = { count: 0, validators: [], slots: [] };
                        }
                        missedByLabel[label].validators.push(vi);
                        missedByLabel[label].count += slots.length;
                        missedByLabel[label].slots.push(...slots);
                    }

                    for (const [label, data] of Object.entries(missedByLabel)) {
                        const validatorLinks = data.validators.map(v =>
                            `<a href="https://beaconcha.in/validator/${v}#attestations">${v}</a>`
                        );
                        const uniqueSlots = [...new Set(data.slots)].sort((a, b) => a - b);
                        const slotLinks = uniqueSlots.map(s =>
                            `<a href="https://beaconcha.in/slot/${s}">${s}</a>`
                        );

                        const message = emoji.get('heavy_exclamation_mark') +
                            ' <i>' + label + '</i> validator(s) ' +
                            validatorLinks.join(', ') +
                            ' missed ' + data.count + ' attestation(s) at slot(s): ' +
                            slotLinks.join(', ');

                        sendTelegramNotification(message, {
                            parse_mode: "HTML",
                            disable_web_page_preview: true
                        });
                    }

                    // Clear for next batch
                    missedAttestations = {};
                }

                // Send batch notifications for withdrawals
                const batchWithdrawalCount = Object.keys(batchWithdrawals).length;
                if (batchWithdrawalCount > 0) {
                    console.log(`[Batch ${batchNum + 1}/${numBatches}] Sending notifications for ${batchWithdrawalCount} validator(s) with withdrawals`);

                    const withdrawalsByLabel = {};
                    for (const [validatorIndex, data] of Object.entries(batchWithdrawals)) {
                        const vi = parseInt(validatorIndex);
                        const label = data.label;

                        if (!withdrawalsByLabel[label]) {
                            withdrawalsByLabel[label] = { validators: [], totalAmount: 0, withdrawalCount: 0 };
                        }
                        withdrawalsByLabel[label].validators.push({
                            index: vi,
                            withdrawals: data.withdrawals,
                            amount: data.total
                        });
                        withdrawalsByLabel[label].totalAmount += data.total;
                        withdrawalsByLabel[label].withdrawalCount += data.withdrawals.length;
                    }

                    for (const [label, data] of Object.entries(withdrawalsByLabel)) {
                        const validatorDetails = data.validators.map(v => {
                            const withdrawalParts = v.withdrawals.map(w =>
                                `${w.amount.toFixed(8)} ETH at slot <a href="https://beaconcha.in/slot/${w.slot}">${w.slot}</a>`
                            );
                            return `<a href="https://beaconcha.in/validator/${v.index}">${v.index}</a>: ${withdrawalParts.join(', ')}`;
                        });

                        const message = emoji.get('money_with_wings') +
                            ' <i>' + label + '</i> validator(s) received ' + data.withdrawalCount + ' withdrawal(s) totaling ' +
                            data.totalAmount.toFixed(8) + ' ETH:\n' +
                            validatorDetails.join('\n');

                        sendTelegramNotification(message, {
                            parse_mode: "HTML",
                            disable_web_page_preview: true
                        });
                    }

                    // Clear for next batch
                    batchWithdrawals = {};
                }

                // Update progress
                lastBlock = batchEndSlot;
                nconf.set('lastBlock', lastBlock);
                nconf.save();
                //console.log(`[Batch ${batchNum + 1}/${numBatches}] Progress saved at slot ${lastBlock}`);
                console.log('');

            } catch (error) {
                console.error(`[Batch ${batchNum + 1}/${numBatches}] Error:`, error.message);
                sendTelegramNotification(emoji.get('x') + ` Error processing batch ${batchNum + 1}: ${error.message}`);

                // Save progress anyway
                lastBlock = batchEndSlot;
                nconf.set('lastBlock', lastBlock);
                nconf.save();
                console.log(`[Batch ${batchNum + 1}/${numBatches}] Progress saved despite error`);
            }
        }

        console.log('=== All batches complete ===');

        // Print cache statistics
        // cache.printStats();

    } catch (error) {
        console.error('Error in main loop:', error);

        // Rate-limit error notifications to prevent spam
        const now = Date.now();
        if (now - lastErrorNotification >= NOTIFICATION_RATE_LIMIT_INTERVAL) {
            sendTelegramNotification(emoji.get('x') + ' Error in monitoring: ' + error.message);
            lastErrorNotification = now;
        }
    }

    // Wait before next cycle
    await sleep(pollingInterval * 1000);
    mainLoop();
}

mainLoop();

// Graceful shutdown handler to clean up resources
function gracefulShutdown(signal) {
    console.log(`\nReceived ${signal}, shutting down gracefully...`);

    // Stop cache cleanup interval
    cache.destroy();
    console.log('Cache cleanup stopped');

    // Print final cache statistics
    console.log('\nFinal cache statistics:');
    cache.printStats();

    process.exit(0);
}

// Register shutdown handlers
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
