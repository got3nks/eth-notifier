process.env["NTBA_FIX_350"] = 1;
const nconf = require('nconf');
const createSubscriber = require('pg-listen');
const { Pool, Client } = require("pg");
const TelegramBot = require('node-telegram-bot-api');
const emoji = require('node-emoji').emoji;
const captureWebsite = require("fix-esm").require('capture-website');

nconf.use('file', { file: './ethNotifier.json' });
nconf.load();

const all_validators = nconf.get('validators');
const pgConnectionObj = { connectionString: `postgresql://${nconf.get("postgresql:username")}:${nconf.get("postgresql:password")}@${nconf.get("postgresql:host")}/${nconf.get("postgresql:database")}` };
const subscriber = createSubscriber(pgConnectionObj);
const db = new Pool(pgConnectionObj); // new Client(pgConnectionObj);

const telegram = new TelegramBot(nconf.get("telegram:token"));
const tgOpts = { parse_mode: 'Markdown' };

process.on('exit', function () {
  subscriber.close();
  db.end();
});

process.on('beforeExit', async () => {
	var msg = 'Ethereum Notifier about to exit: beforeExit emitted';
	console.log(msg);
	sendTelegramNotification(msg);
	process.exit(0); // if you don't close yourself this will run forever
});

['SIGHUP', 'SIGINT', 'SIGQUIT', 'SIGILL', 'SIGTRAP', 'SIGABRT',
    'SIGBUS', 'SIGFPE', 'SIGUSR1', 'SIGSEGV', 'SIGUSR2', 'SIGTERM'
].forEach(function (sig) {
    process.on(sig, function () {
    	console.log('Got signal: ' + sig);
        terminator(sig);
    });
});
function terminator(sig) {
    if (typeof sig === "string") {
		var msg = `Ethereum Notifier about to exit with code: ${sig}`;
		console.log(msg);
		sendTelegramNotification(msg);
		process.exit(1);
    }
    console.log('Ethereum Notifier stopped');
}

function sendTelegramNotification(msg, opts={}) {
	nconf.get("telegram:chatId").forEach(chatId => {
		telegram.sendMessage(chatId, msg, opts);
	});
}
function sendTelegramImage(img, caption="") {
	const fileOptions = {
	  filename: 'screenshot.png',
	  contentType: 'image/png',
	};
	nconf.get("telegram:chatId").forEach(chatId => {
		telegram.sendPhoto(chatId, img, {caption: caption}, fileOptions);
	});
}

async function getNewBlocks(fromBlockId) {
  const query = `SELECT f_slot,f_proposer_index,f_canonical FROM t_blocks WHERE f_slot > $1 AND f_canonical = true ORDER BY f_slot ASC`;
  const values = [fromBlockId];
  return db.query(query, values);
}

async function getBlock(blockId) {
  const query = `SELECT f_slot,f_proposer_index,f_canonical FROM t_blocks WHERE f_slot = $1 LIMIT 1`;
  const values = [blockId];
  return db.query(query, values);
}

async function getProposerDuties(fromBlockId, toBlockId, validators=null) {
  const query = 'SELECT * FROM t_proposer_duties WHERE f_slot > $1 AND f_slot <= $2 AND f_validator_index = ANY($3)';
  if(!validators) {
  	validators = Object.values(all_validators).flat();
  }
  const values = [fromBlockId, toBlockId, validators];
  return db.query(query, values);
}

async function getAttestationDuties(fromBlockId, toBlockId, validators=null) {
  if(!validators) {
  	validators = Object.values(all_validators).flat();
  }
  const query = 'SELECT * FROM t_beacon_committees WHERE f_slot > $1 AND f_slot <= $2 AND ARRAY[$3::bigint[]]::bigint[] && f_committee';
  const values = [fromBlockId, toBlockId, validators];
  return db.query(query, values);
}

async function getAttestations(fromBlockId, toBlockId, validators=null) {
  if(!validators) {
  	validators = Object.values(all_validators).flat();
  }
  const query = 'SELECT f_slot,f_inclusion_slot,f_inclusion_index,f_aggregation_indices FROM t_attestations WHERE f_slot > $1 AND f_slot <= $2 AND ARRAY[$3::bigint[]]::bigint[] && f_aggregation_indices';
  const values = [fromBlockId, toBlockId, validators];
  return db.query(query, values);
}

/*
subscriber.notifications.on("my-channel", (payload) => {
  // Payload as passed to subscriber.notify() (see below)
  msg = "Received notification in 'my-channel':", payload;
  console.log(msg);
  // telegram.sendMessage(nconf.get("telegram:chatId"), msg, tgOpts);
})

subscriber.events.on("connected", () => {
  console.error("Connected to database successfully.")
})


subscriber.events.on("error", (error) => {
  console.error("Fatal database connection error:", error)
  process.exit(1)
})
*/

//subscriber.connect();
//subscriber.listenTo("my-channel");

var lastBlock = parseInt(nconf.get('lastBlock'));
const validators_strings = Object.values(all_validators).flat().map(String);
const sleep = (waitTimeInMs) => new Promise(resolve => setTimeout(resolve, waitTimeInMs));
function mainLoop() {
	sleep(15*60*1000).then(() => {
		var promises=[],
			missedAttestations = {},
			submittedAttestations = {};

  		getNewBlocks(lastBlock).then(blocksToScan => {
  			// var blocksToScan = blocksToScan.rows.slice(0, -32*2), // attestations absolute upper limit for inclusion is 1 epoch, i.e. 32 slots. check 2 epochs behind
  			// we query only canonical blocks now in getNewBlocks
  			var blocksToScan = blocksToScan.rows,
  					newestBlock = blocksToScan[blocksToScan.length-1];

  			if(typeof newestBlock !== 'undefined' && newestBlock) {
  				newestBlock = parseInt(newestBlock['f_slot']);
  				console.log('Found ', blocksToScan.length, ' new blocks to scan. From', lastBlock, ' to ', newestBlock);
	  			
	  			//blocksToScan.forEach(block => {
	  			while(lastBlock < newestBlock) {
	  				if(blocksToScan[0].f_slot != lastBlock+1) {
	  					var block = null,
	  						currentBlock = lastBlock+1;
	  					console.log('WARNING: ', (blocksToScan[0].f_slot - lastBlock - 1) ,' missing block(s) between ', blocksToScan[0].f_slot, 'and', lastBlock);
	  				} else {
	  					var block = blocksToScan.shift(),
	  						currentBlock = parseInt(block['f_slot']);
	  				}

	  				(function(lastBlock, currentBlock, block) {
	  					console.log('Checking block ',currentBlock, block);

		  				proposerDuties = getProposerDuties(lastBlock, currentBlock);
		  				attestationDuties = getAttestationDuties(lastBlock, currentBlock);
		  				attestations = getAttestations(lastBlock, currentBlock);
		  				
		  				promises.push(new Promise((resolve, reject) => {
			  				Promise.all([proposerDuties, attestationDuties, attestations]).then(data => {
								const proposerDuties = data[0].rows;
								const attestationDuties = data[1].rows;
								const attestations = data[2].rows;

								proposerDuties.forEach(proposerDuty => {
									var label = Object.keys(all_validators).find(key => all_validators[key].includes(parseInt(proposerDuty['f_validator_index'])));
									if(block !== null && block['f_slot'] == proposerDuty['f_slot'] && block['f_proposer_index'] == proposerDuty['f_validator_index']) {
										console.log(`SUCCESSFULLY PROPOSED BLOCK ${block['f_slot']} by validator ${block['f_proposer_index']} (${label})`);
										
										sendTelegramNotification(emoji.white_check_mark + ' Validator <a href="https://beaconcha.in/validator/'+block['f_proposer_index']+'#blocks">'+block['f_proposer_index']+'</a> (<i>'+label+'</i>) proposed block <a href="https://beaconcha.in/slot/'+block['f_slot']+'">'+block['f_slot']+'</a>', {parse_mode : "HTML", disable_web_page_preview: true});
										
										var blockUrl = 'https://beaconcha.in/slot/'+block['f_slot']+'#overview';
										captureWebsite.default.buffer(blockUrl, { hideElements: ['#cookie-banner'] }).then(imgBuffer => {
											sendTelegramImage(imgBuffer, blockUrl);
										});
									} else {
										console.log(`MISSED BLOCK PROPOSAL ${proposerDuty['f_slot']} by validator ${proposerDuty['f_validator_index']} (${label})`);
										sendTelegramNotification(emoji.x + ' Validator <a href="https://beaconcha.in/validator/'+proposerDuty['f_validator_index']+'#blocks">'+proposerDuty['f_validator_index']+'</a> (<i>'+label+'</i>) failed to propose block <a href="https://beaconcha.in/slot/'+proposerDuty['f_slot']+'">'+proposerDuty['f_slot']+'</a>', {parse_mode : "HTML", disable_web_page_preview: true});
									}
								});
								attestationDuties.forEach(beacon_committees => {
									var validatorsIndexes = beacon_committees['f_committee'].filter(value => validators_strings.includes(value)),
										found = [];
									//console.log(validatorsIndexes);

									attestations.forEach(attestation => {
										validatorsIndexes.forEach(validatorIndex => {
											if(found.includes(validatorIndex)) {
												return;
											}
											if(attestation.f_aggregation_indices.includes(validatorIndex)) {
												found.push(validatorIndex);
												return;
											}
										});
									});

									if(found.length != validatorsIndexes.length) {
										let validatorsMissedAttestations = validatorsIndexes.filter(function(e){
											return !(found.includes(e));    
										});
										console.log(`MISSED ATTESTATION at block ${currentBlock} for validators ${validatorsMissedAttestations}`); // [${validatorsIndexes} (found ${found})];
										validatorsMissedAttestations.forEach(validatorIndex => {
											if(!missedAttestations.hasOwnProperty(validatorIndex)) {
												missedAttestations[validatorIndex]=[];
											}
											if(!missedAttestations[validatorIndex].includes(currentBlock)) {
												missedAttestations[validatorIndex].push(currentBlock);
											}
										});
									}
									found.forEach(validatorIndex => {
										if(!submittedAttestations.hasOwnProperty(validatorIndex)) {
											submittedAttestations[validatorIndex]=[];
										}
										if(!submittedAttestations[validatorIndex].includes(currentBlock)) {
											submittedAttestations[validatorIndex].push(currentBlock);
										}
									});
								});
								//console.log('Processed block ',currentBlock);
								resolve(true);
							});
						}));
					})(lastBlock, currentBlock, block);

	  				lastBlock = currentBlock;
	  			}

  			} else {
  				sendTelegramNotification(emoji.warning + ' Could not find new blocks - Consensus Client offline?');
  			}
  			
	  		Promise.all(promises).then((results) => {
	  			console.log('Processed all blocks until ',lastBlock);
	  			
	  			notifications = '';
	  			missedAttestationsByLabel = {};
	  			for (var [validatorIndex, blocks] of Object.entries(missedAttestations)) {
	  				var label = Object.keys(all_validators).find(key => all_validators[key].includes(parseInt(validatorIndex)));
	  				if(!missedAttestationsByLabel.hasOwnProperty(label)) {
	  					missedAttestationsByLabel[label]={'count':0,'indexes':[],'blocks':[]};
	  				}
	  				missedAttestationsByLabel[label]['indexes'].push(validatorIndex);
	  				missedAttestationsByLabel[label]['count'] = missedAttestationsByLabel[label]['count']+blocks.length;
	  				missedAttestationsByLabel[label]['blocks'] = Array.from(new Set(missedAttestationsByLabel[label]['blocks'].concat(blocks).map(Number))).sort((a, b) => a - b);
	  			}

	  			for (var [label, obj] of Object.entries(missedAttestationsByLabel)) {
					  var blocks = obj['blocks'].map(x => '<a href="https://beaconcha.in/slot/'+x+'">'+x+'</a>');
					  var validators = obj['indexes'].map(x => '<a href="https://beaconcha.in/validator/'+x+'#attestations">'+x+'</a>'); // '<a href="https://beaconcha.in/validator/'+validatorIndex+'#attestations">'+validatorIndex+'</a>'
					  var count = obj['count']; // blocks.length;
					  notifications += emoji.heavy_exclamation_mark + ' <i>'+label+'</i> validator(s) '+validators+' missed '+count+' attestation(s) at block(s): '+blocks.join(',');
					  notifications += '\n';
					}
	  			if(notifications.length > 0) {
	  				sendTelegramNotification(notifications, {parse_mode : "HTML", disable_web_page_preview: true});
	  			}
	  			for (var [validatorIndex, blocks] of Object.entries(submittedAttestations)) {
	  				var label = Object.keys(all_validators).find(key => all_validators[key].includes(parseInt(validatorIndex)));
				  	console.log(emoji.white_check_mark + ' Validator '+validatorIndex+' ('+label+') submitted '+blocks.length+' attestation(s) at block(s): '+blocks.join(','));
					}
	  			nconf.set('lastBlock', lastBlock);
					nconf.save();
	  			mainLoop();
	  		});
  		});
	});
}
mainLoop();
