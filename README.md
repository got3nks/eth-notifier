# eth-notifier
You can use this script to notify your Telegram Bot of missed attestations and produced/missed block proposals for any validators of your choice. 
As a bonus it generates a screenshot of the produced blocks too.

## Pre-requisites

1. Install **chaind** and wait till it is fully sync'd: https://github.com/wealdtech/chaind. It will take few days, sit back and relax.
2. Install node v14 or newer: https://nodejs.org/it/download/
3. Create your Telegram Bot: https://telegram.me/BotFather

## Configuration

Just edit the config.json file:

1. Update your PostegreSQL settings with your choosen user/pass/db for chaind.
2. Update your Telegram Bot settings with your token and chatId (it uses an array so you can have multiple chatIds)
3. Update the validators section with your validators. It uses labels so you can have different clusters of validator (notifications will show the labels)

## Running the monitoring script

First of all install the Node depenencies running:

> npm install

Then execute it:

> node ethNotifier.js
