/**
 * Lighthouse Beacon API Replacements for chaind PostgreSQL queries
 * All functions replaced with direct HTTP calls to Lighthouse beacon node
 */

const axios = require('axios');
const cache = require('./cache');
// const metrics = require('./metrics/metrics');

// Initialize metrics tracking for all axios requests
// metrics.setupMetrics(axios);

const LIGHTHOUSE_URL = process.env.LIGHTHOUSE_URL || 'http://127.0.0.1:5052';
const SLOTS_PER_EPOCH = 32;

// Helper to convert slot to epoch
function slotToEpoch(slot) {
    return Math.floor(slot / SLOTS_PER_EPOCH);
}

// Helper to get epoch range from slot range
function getEpochRange(fromSlot, toSlot) {
    const fromEpoch = slotToEpoch(fromSlot);
    const toEpoch = slotToEpoch(toSlot);
    const epochs = [];
    for (let epoch = fromEpoch; epoch <= toEpoch; epoch++) {
        epochs.push(epoch);
    }
    return epochs;
}

// In-flight request tracking to prevent duplicate fetches
const blockRequests = new Map();

/**
 * Helper function to get a block with caching
 * Checks cache first, fetches from API if not cached
 * Prevents duplicate concurrent requests for the same slot
 * @param {number} slot - The slot number
 * @returns {Promise<object|null>} Block data or null if slot was missed
 */
async function getCachedBlock(slot) {
    // Check if block is in cache (doesn't record stats)
    if (cache.hasBlock(slot)) {
        // In cache, get it (this records HIT and returns value, which could be null for 404)
        return cache.getBlock(slot);
    }

    // Check if there's already an in-flight request for this slot
    if (blockRequests.has(slot)) {
        // Return the existing promise to avoid duplicate fetches
        return blockRequests.get(slot);
    }

    // Not in cache, record MISS by calling getBlock (returns null)
    cache.getBlock(slot);

    // Create new fetch promise
    const fetchPromise = (async () => {
        try {
            // Fetch from API
            const response = await axios.get(
                `${LIGHTHOUSE_URL}/eth/v2/beacon/blocks/${slot}`,
                { headers: { 'Accept': 'application/json' } }
            );
            const blockData = response.data.data;
            // Cache the block data
            cache.setBlock(slot, blockData);
            return blockData;
        } catch (error) {
            if (error.response && error.response.status === 404) {
                // No block at this slot (missed), cache as null
                cache.setBlock(slot, null);
                return null;
            }
            throw error;
        } finally {
            // Clean up in-flight request tracker
            blockRequests.delete(slot);
        }
    })();

    // Store the in-flight promise
    blockRequests.set(slot, fetchPromise);

    return fetchPromise;
}

// In-flight request tracking to prevent duplicate fetches
const committeeRequests = new Map();

/**
 * Helper function to get committees for a slot with caching
 * Checks cache first, fetches from API if not cached
 * Prevents duplicate concurrent requests for the same slot
 * @param {number} slot - The slot number
 * @returns {Promise<Array>} Array of committee objects for the slot
 */
async function getCachedCommittees(slot) {
    // Check if committees are in cache (doesn't record stats)
    if (cache.hasSlotCommittees(slot)) {
        // In cache, get them (this records HIT)
        return cache.getSlotCommittees(slot);
    }

    // Check if there's already an in-flight request for this slot
    if (committeeRequests.has(slot)) {
        // Return the existing promise to avoid duplicate fetches
        return committeeRequests.get(slot);
    }

    // Not in cache, record MISS by calling getSlotCommittees (returns null)
    cache.getSlotCommittees(slot);

    // Create new fetch promise
    const fetchPromise = (async () => {
        try {
            // Fetch from API
            const response = await axios.get(
                `${LIGHTHOUSE_URL}/eth/v1/beacon/states/${slot}/committees`,
                { params: { slot: slot } }
            );

            const committees = response.data.data
                .filter(c => parseInt(c.slot) === slot)
                .sort((a, b) => parseInt(a.index) - parseInt(b.index));

            // Cache the committees
            cache.setSlotCommittees(slot, committees);

            return committees;
        } finally {
            // Clean up in-flight request tracker
            committeeRequests.delete(slot);
        }
    })();

    // Store the in-flight promise
    committeeRequests.set(slot, fetchPromise);

    return fetchPromise;
}

/**
 * REPLACEMENT FOR: getNewBlocks(fromBlockId)
 * Original: SELECT f_slot,f_proposer_index,f_canonical FROM t_blocks
 *          WHERE f_slot > $1 AND f_canonical = true ORDER BY f_slot ASC
 *
 * Strategy: Get current head slot, then fetch each block from fromBlockId+1 to head
 * Only returns blocks that exist (canonical chain)
 */
async function getNewBlocks(fromBlockId) {
    try {
        // Get current head to know how far to scan
        const headResponse = await axios.get(`${LIGHTHOUSE_URL}/eth/v1/beacon/headers/head`);
        const headSlot = parseInt(headResponse.data.data.header.message.slot);

        const blocks = [];

        // Scan from fromBlockId+1 to headSlot
        for (let slot = fromBlockId + 1; slot <= headSlot; slot++) {
            try {
                // Get block with caching
                const blockData = await getCachedBlock(slot);

                if (blockData !== null) {
                    const message = blockData.message || blockData; // Handle both signed and unsigned

                    blocks.push({
                        f_slot: parseInt(message.slot),
                        f_proposer_index: parseInt(message.proposer_index),
                        f_exec_block_number: message.body.execution_payload ? parseInt(message.body.execution_payload.block_number) : null,
                    });
                }
                // If blockData is null, slot was missed/skipped - continue
            } catch (error) {
                console.error(`Error fetching block at slot ${slot}:`, error.message);
            }
        }

        return { rows: blocks };
    } catch (error) {
        console.error('Error in getNewBlocks:', error.message);
        return { rows: [] };
    }
}

/**
 * REPLACEMENT FOR: getProposerDuties(fromBlockId, toBlockId, validators)
 * Original: SELECT * FROM t_proposer_duties WHERE f_slot > $1 AND f_slot <= $2 
 *          AND f_validator_index = ANY($3)
 * 
 * Strategy: Query proposer duties for each epoch in range, filter by validators
 */
async function getProposerDuties(fromBlockId, toBlockId, validators = null) {
    try {
        const epochs = getEpochRange(fromBlockId, toBlockId);
        const allDuties = [];
        
        for (const epoch of epochs) {
            try {
                const response = await axios.get(
                    `${LIGHTHOUSE_URL}/eth/v1/validator/duties/proposer/${epoch}`
                );
                
                const duties = response.data.data;
                
                // Filter duties to only slots in our range and validators we care about
                duties.forEach(duty => {
                    const slot = parseInt(duty.slot);
                    const validatorIndex = parseInt(duty.validator_index);
                    
                    // Check if slot is in range
                    if (slot > fromBlockId && slot <= toBlockId) {
                        // Check if we should filter by validators
                        if (!validators || validators.includes(validatorIndex)) {
                            allDuties.push({
                                f_slot: slot,
                                f_validator_index: validatorIndex,
                                f_pubkey: duty.pubkey
                            });
                        }
                    }
                });
            } catch (error) {
                console.error(`Error fetching proposer duties for epoch ${epoch}:`, error.message);
            }
        }
        
        return { rows: allDuties };
    } catch (error) {
        console.error('Error in getProposerDuties:', error.message);
        return { rows: [] };
    }
}

/**
 * REPLACEMENT FOR: getAttestationDuties(fromBlockId, toBlockId, validators)
 * Original: SELECT * FROM t_beacon_committees WHERE f_slot > $1 AND f_slot <= $2
 *          AND ARRAY[$3::bigint[]]::bigint[] && f_committee
 *
 * Strategy: Get beacon committees for each slot, filter to committees containing our validators
 */
async function getAttestationDuties(fromBlockId, toBlockId, validators = null) {
    try {
        const allCommittees = [];

        // Need to query committees for each slot in range
        for (let slot = fromBlockId + 1; slot <= toBlockId; slot++) {
            try {
                // Get committees with caching
                const committees = await getCachedCommittees(slot);

                // Process each committee
                committees.forEach(committee => {
                    const committeeValidators = committee.validators.map(v => parseInt(v));

                    // Check if any of our validators are in this committee
                    if (!validators || validators.some(v => committeeValidators.includes(v))) {
                        allCommittees.push({
                            f_slot: parseInt(committee.slot),
                            f_committee_index: parseInt(committee.index),
                            f_committee: committeeValidators
                        });
                    }
                });
            } catch (error) {
                if (error.response && error.response.status === 404) {
                    // State not available for this slot, skip
                    continue;
                }
                console.error(`Error fetching committees for slot ${slot}:`, error.message);
            }
        }

        return { rows: allCommittees };
    } catch (error) {
        console.error('Error in getAttestationDuties:', error.message);
        return { rows: [] };
    }
}

/**
 * REPLACEMENT FOR: getAttestations(fromBlockId, toBlockId, validators)
 * Original: SELECT f_slot,f_inclusion_slot,f_inclusion_index,f_aggregation_indices 
 *          FROM t_attestations WHERE f_slot > $1 AND f_slot <= $2 
 *          AND ARRAY[$3::bigint[]]::bigint[] && f_aggregation_indices
 * 
 * Strategy: Get each block, parse attestations, decode aggregation_bits to get validator indices
 */
async function getAttestations(fromBlockId, toBlockId, validators = null) {
    try {
        const allAttestations = [];
        
        // Attestations from slot X can be included in blocks X+1 through X+32
        const scanToSlot = toBlockId + 32;
        
        console.log(`  Scanning blocks ${fromBlockId + 1} to ${scanToSlot} for attestations from slots ${fromBlockId + 1} to ${toBlockId}`);
        
        // Scan each slot for blocks containing attestations
        for (let slot = fromBlockId + 1; slot <= scanToSlot; slot++) {
            try {
                // Get block with caching
                const blockData = await getCachedBlock(slot);

                // Check if slot was missed (no block)
                if (blockData === null) {
                    continue;
                }

                const message = blockData.message || blockData;
                const attestations = message.body.attestations || [];

                // Process each attestation in the block
                for (const attestation of attestations) {
                    const attestationSlot = parseInt(attestation.data.slot);
                    const committeeIndex = parseInt(attestation.data.index);

                    // Only process attestations FOR slots in our target range
                    // (we scan ahead to catch late attestations, but only want attestations from our range)
                    if (attestationSlot <= fromBlockId || attestationSlot > toBlockId) {
                        continue;
                    }

                    // Get committees for this attestation slot to map bits to validator indices
                    try {
                        // Get committees with caching
                        const allCommittees = await getCachedCommittees(attestationSlot);

                        // Check if this is an Electra multi-committee attestation (EIP-7549)
                        if (attestation.committee_bits) {
                            // Electra fork: attestation covers multiple committees
                            // Decode committee_bits to find which committees are included
                            const includedCommittees = decodeCommitteeBits(attestation.committee_bits, allCommittees.length);

                            // Decode the full aggregation_bits into bits once
                            const hex = attestation.aggregation_bits.startsWith('0x')
                                ? attestation.aggregation_bits.slice(2)
                                : attestation.aggregation_bits;
                            const bytes = Buffer.from(hex, 'hex');
                            const bits = [];
                            for (const byte of bytes) {
                                for (let i = 0; i < 8; i++) {
                                    bits.push((byte >> i) & 1);
                                }
                            }

                            // Find delimiter bit
                            let delimiterPos = bits.length - 1;
                            while (delimiterPos >= 0 && bits[delimiterPos] === 0) {
                                delimiterPos--;
                            }

                            if (delimiterPos >= 0) {
                                // Process each committee separately to create one attestation record per committee
                                // This ensures attestation count matches duties count for clearer output
                                let offset = 0;
                                for (const committeeIdx of includedCommittees) {
                                    const committee = allCommittees.find(c => parseInt(c.index) === committeeIdx);
                                    if (!committee) {
                                        continue;
                                    }

                                    const committeeValidators = committee.validators;
                                    const committeeSize = committeeValidators.length;

                                    // Extract which validators in this specific committee attested
                                    const attestingValidators = [];
                                    for (let i = 0; i < committeeSize && (offset + i) < delimiterPos; i++) {
                                        if (bits[offset + i] === 1) {
                                            attestingValidators.push(parseInt(committeeValidators[i]));
                                        }
                                    }

                                    // Filter to only our validators if specified
                                    const filteredIndices = !validators
                                        ? attestingValidators
                                        : attestingValidators.filter(v => validators.includes(v));

                                    if (filteredIndices.length > 0) {
                                        allAttestations.push({
                                            f_slot: attestationSlot,
                                            f_inclusion_slot: slot,
                                            f_inclusion_index: committeeIdx,
                                            f_aggregation_indices: filteredIndices
                                        });
                                    }

                                    offset += committeeSize;
                                }
                            }
                        } else {
                            // Pre-Electra: attestation is for a single committee
                            const specificCommittee = allCommittees.find(c => parseInt(c.index) === committeeIndex);
                            if (!specificCommittee) {
                                continue;
                            }
                            const committeeValidators = specificCommittee.validators;

                            // Decode aggregation_bits to get which validators attested
                            const aggregationIndices = decodeAggregationBits(
                                attestation.aggregation_bits,
                                committeeValidators
                            );

                            // Filter to only our validators if specified
                            const filteredIndices = !validators
                                ? aggregationIndices
                                : aggregationIndices.filter(v => validators.includes(v));

                            if (filteredIndices.length > 0) {
                                allAttestations.push({
                                    f_slot: attestationSlot,
                                    f_inclusion_slot: slot,
                                    f_inclusion_index: committeeIndex,
                                    f_aggregation_indices: filteredIndices
                                });
                            }
                        }
                    } catch (error) {
                        console.error(`Error fetching committee for attestation:`, error.message);
                    }
                }
            } catch (error) {
                console.error(`Error processing attestations at slot ${slot}:`, error.message);
            }
        }

        // De-duplicate and group attestations by (slot, committee)
        // Multiple aggregate attestations can include the same committee, and multiple validators
        // from our monitoring list can be in the same committee - group them together
        const uniqueAttestations = new Map();
        for (const attestation of allAttestations) {
            const key = `${attestation.f_slot}-${attestation.f_inclusion_index}`;

            if (!uniqueAttestations.has(key)) {
                uniqueAttestations.set(key, {
                    f_slot: attestation.f_slot,
                    f_inclusion_slot: attestation.f_inclusion_slot,
                    f_inclusion_index: attestation.f_inclusion_index,
                    f_aggregation_indices: [...attestation.f_aggregation_indices]
                });
            } else {
                // Merge validators from the same committee
                const existing = uniqueAttestations.get(key);
                for (const validatorIndex of attestation.f_aggregation_indices) {
                    if (!existing.f_aggregation_indices.includes(validatorIndex)) {
                        existing.f_aggregation_indices.push(validatorIndex);
                    }
                }
            }
        }

        const deduplicatedAttestations = Array.from(uniqueAttestations.values());

        console.log(`  Found ${deduplicatedAttestations.length} attestations for slots ${fromBlockId + 1} to ${toBlockId} (scanned up to slot ${scanToSlot})`);

        return { rows: deduplicatedAttestations };
    } catch (error) {
        console.error('Error in getAttestations:', error.message);
        return { rows: [] };
    }
}

/**
 * Helper function to decode committee_bits to find which committees are included
 * committee_bits is from Electra fork (EIP-7549) and indicates which committees are in the attestation
 * @param {string} committeeBitsHex - Hex string like "0x8cb2f81111b15cd1"
 * @param {number} totalCommittees - Total number of committees for the slot
 * @returns {Array<number>} Array of committee indices that are included
 */
function decodeCommitteeBits(committeeBitsHex, totalCommittees) {
    const hex = committeeBitsHex.startsWith('0x')
        ? committeeBitsHex.slice(2)
        : committeeBitsHex;

    const bytes = Buffer.from(hex, 'hex');
    const includedCommittees = [];

    // Each bit represents a committee index (LSB first within each byte)
    for (let byteIndex = 0; byteIndex < bytes.length; byteIndex++) {
        const byte = bytes[byteIndex];
        for (let bitIndex = 0; bitIndex < 8; bitIndex++) {
            const committeeIndex = byteIndex * 8 + bitIndex;
            if (committeeIndex >= totalCommittees) break;

            if ((byte >> bitIndex) & 1) {
                includedCommittees.push(committeeIndex);
            }
        }
    }

    return includedCommittees;
}

/**
 * Helper function to decode aggregation_bits into validator indices
 * aggregation_bits is a hex string like "0xffff" where each bit represents a validator
 *
 * IMPORTANT: aggregation_bits uses SSZ bitlist encoding:
 * - Bits within each byte are in little-endian order (LSB first)
 * - A delimiter bit '1' is added at the end to mark the length
 * - Bits before the delimiter represent which validators attested
 */
function decodeAggregationBits(aggregationBitsHex, committeeValidators) {
    // Remove '0x' prefix
    const hex = aggregationBitsHex.startsWith('0x')
        ? aggregationBitsHex.slice(2)
        : aggregationBitsHex;

    // Convert hex to bytes
    const bytes = Buffer.from(hex, 'hex');

    // Extract bits in little-endian order (LSB first within each byte)
    const bits = [];
    for (const byte of bytes) {
        for (let i = 0; i < 8; i++) {
            bits.push((byte >> i) & 1);
        }
    }

    // Find the delimiter bit (rightmost '1' bit)
    // The bitlist length is the position of the delimiter bit
    let delimiterPos = bits.length - 1;
    while (delimiterPos >= 0 && bits[delimiterPos] === 0) {
        delimiterPos--;
    }

    if (delimiterPos < 0) {
        return [];
    }

    // Map bits to validator indices (only bits before the delimiter)
    const attestingValidators = [];
    for (let i = 0; i < delimiterPos && i < committeeValidators.length; i++) {
        if (bits[i] === 1) {
            attestingValidators.push(parseInt(committeeValidators[i]));
        }
    }

    return attestingValidators;
}

/**
 * REPLACEMENT FOR: getBeaconWithdrawals(fromBlockId, toBlockId, validators)
 * Original: SELECT f_block_number, f_validator_index, f_address, 
 *          CAST(f_amount AS DOUBLE PRECISION)/1000000000 as f_amount 
 *          FROM t_block_withdrawals WHERE f_block_number > $1 AND f_block_number <= $2 
 *          AND f_validator_index = ANY($3)
 * 
 * Strategy: Get each block's execution payload, extract withdrawals array
 */
async function getBeaconWithdrawals(fromBlockId, toBlockId, validators = null) {
    try {
        const allWithdrawals = [];
        
        // Scan each slot for blocks containing withdrawals
        for (let slot = fromBlockId + 1; slot <= toBlockId; slot++) {
            try {
                // Get block with caching
                const blockData = await getCachedBlock(slot);

                // Check if slot was missed (no block)
                if (blockData === null) {
                    continue;
                }

                const message = blockData.message || blockData;

                // Withdrawals are in the execution payload (post-Capella)
                const executionPayload = message.body.execution_payload;

                if (executionPayload && executionPayload.withdrawals) {
                    executionPayload.withdrawals.forEach(withdrawal => {
                        const validatorIndex = parseInt(withdrawal.validator_index);

                        // Filter to only our validators if specified
                        if (!validators || validators.includes(validatorIndex)) {
                            // Amount is in Gwei, convert to ETH
                            const amountGwei = parseInt(withdrawal.amount);
                            const amountEth = amountGwei / 1000000000;

                            allWithdrawals.push({
                                f_slot: slot,
                                f_block_number: parseInt(executionPayload.block_number),
                                f_validator_index: validatorIndex,
                                f_address: withdrawal.address,
                                f_amount: amountEth
                            });
                        }
                    });
                }
            } catch (error) {
                console.error(`Error processing withdrawals at slot ${slot}:`, error.message);
            }
        }

        return { rows: allWithdrawals };
    } catch (error) {
        console.error('Error in getBeaconWithdrawals:', error.message);
        return { rows: [] };
    }
}

module.exports = {
    getNewBlocks,
    getProposerDuties,
    getCachedCommittees,  // Export for pre-fetching optimization
    getAttestationDuties,
    getAttestations,
    getBeaconWithdrawals,
    LIGHTHOUSE_URL,
    cache  // Export cache for statistics
};