# Ethereum Validator Notifier

A real-time monitoring tool for Ethereum validators that sends Telegram notifications for important events including block proposals, missed attestations, and beacon chain withdrawals.

<img src="https://github.com/user-attachments/assets/dafcacbd-1ce4-42f4-825b-8f40f07b6442" width="400" />

## Features

- **Block Proposal Monitoring**: Notifications for successful and missed block proposals
- **MEV Reward Tracking**: Automatic detection and reporting of MEV rewards for proposed blocks
- **Attestation Monitoring**: Detection of missed attestations with batch notifications
- **Withdrawal Notifications**: Alerts for beacon chain withdrawals
- **Batch Processing**: Efficient processing of multiple slots with configurable batch sizes
- **Safety Margin**: Configurable epoch delay to avoid processing non-finalized data
- **Multiple Validators**: Support for monitoring multiple validators with custom labels
- **Telegram Integration**: Two methods for sending notifications (CLI wrapper or Bot API)
- **Stale Node Detection**: Automatic alerts when the beacon node falls behind

## Requirements

### Prerequisites

- **Node.js** 18.x or higher
- **Lighthouse Beacon Node** with the following **CRITICAL** requirement:

  **IMPORTANT**: Your Lighthouse beacon node **MUST** be running with the `--reconstruct-historic-states` flag enabled. This is required for the application to retrieve historical validator duties and attestations.

  ```bash
  lighthouse bn --reconstruct-historic-states [other flags...]
  ```

- **Telegram Bot Token** (obtain from [@BotFather](https://t.me/botfather))
- **Telegram Chat ID(s)** for receiving notifications

### Optional

- **telegram-cli-wrapper** (only if using `wrapper` method for Telegram notifications)

## Installation

1. Clone the repository:
   ```bash
   git clone https://github.com/got3nks/eth-notifier
   cd eth-notifier
   ```

2. Install dependencies:
   ```bash
   npm install
   ```

3. Copy and configure the settings file:
   ```bash
   cp ethNotifier.json.example ethNotifier.json
   ```

4. Edit `ethNotifier.json` with your configuration (see Configuration section below)

## Configuration

Edit `ethNotifier.json` to configure the notifier:

```json
{
  "lastBlock": 13132000,
  "maxConcurrentRequests": 30,
  "batchSize": 100,
  "pollingInterval": 60,
  "epochsBeforeFinal": 1,
  "telegram": {
    "method": "bot-api",
    "token": "YOUR_TELEGRAM_BOT_TOKEN",
    "chatId": [123456789]
  },
  "validators": {
    "My Validators": [123456,123457]
  }
}
```

### Configuration Options

| Option | Type | Description                                                        |
|--------|------|--------------------------------------------------------------------|
| `lastBlock` | number | Last processed slot (automatically updated)                        |
| `maxConcurrentRequests` | number | Maximum concurrent API requests to beacon node (default: 30)       |
| `batchSize` | number | Number of slots to process per batch (default: 100)                |
| `pollingInterval` | number | Seconds between polling cycles (default: 60)                       |
| `epochsBeforeFinal` | number | Number of epochs behind head to process (default: 1)               |
| `telegram.method` | string | Telegram method: `"bot-api"` or `"wrapper"` (default: `"bot-api"`) |
| `telegram.token` | string | Your Telegram bot token                                            |
| `telegram.chatId` | array | Array of Telegram chat IDs to send notifications to                |
| `validators` | object | Groups of validators to monitor with custom labels                 |

### Telegram Notification Methods

The application supports two methods for sending Telegram notifications:

#### 1. Bot API (Recommended)
Uses the official `node-telegram-bot-api` package. This is the recommended method as it's more reliable and doesn't require external dependencies.

```json
"telegram": {
"method": "bot-api",
...
}
```

#### 2. CLI Wrapper
Uses an external `telegram-cli-wrapper` executable. Requires the wrapper to be installed at `/usr/local/bin/telegram-cli-wrapper` or set via the `TELEGRAM_CLI_WRAPPER` environment variable.

```json
"telegram": {
"method": "wrapper",
...
}
```

## Usage

### Starting the Notifier

```bash
npm start
```

Or directly with Node.js:

```bash
node ethNotifier.js
```

### Test Mode

Run without sending Telegram notifications:

```bash
TEST_MODE=true node ethNotifier.js
```

### Environment Variables

| Variable | Description |
|----------|-------------|
| `TEST_MODE` | Set to `"true"` to disable Telegram notifications |
| `TELEGRAM_CLI_WRAPPER` | Path to telegram-cli-wrapper (only for `wrapper` method) |

## Lighthouse Configuration

### Required Lighthouse Flags

Your Lighthouse beacon node must be started with:

```bash
lighthouse bn --reconstruct-historic-states
```

### Recommended Additional Flags

For optimal performance, consider these additional flags:

```bash
lighthouse bn \
  --disable-backfill-rate-limiting \
  --slots-per-restore-point 1024 \
  --reconstruct-historic-states \
  [other flags...]
```

### Lighthouse URL Configuration

The application connects to Lighthouse at `http://127.0.0.1:5052` by default. To use a different URL, set the environment variable:

```bash
LIGHTHOUSE_URL=http://your-lighthouse-node:5052 node ethNotifier.js
```

## Notification Examples

### Block Proposal
```
✅ Validator 123456 (My Validators) proposed block 13106031
💰 MEV Reward for block 13106031: 0.05234 ETH
```

### Missed Block
```
❌ Validator 123456 (My Validators) failed to propose block 13106031
```

### Missed Attestations
```
❗ My Validators validator(s) 123456, 123457 missed 2 attestation(s) at slot(s): 13106032, 13106033
```

### Withdrawals
```
💸 Validator 123456 (My Validators) received a beacon withdrawal of 0.01234567 ETH
```

### Stale Node Warning
```
⚠️ Beacon node is 15 slots behind - Consensus Client may be offline or stale
```

## How It Works

1. **Polling**: The notifier polls the Lighthouse beacon node every `pollingInterval` seconds
2. **Safe Processing**: Only processes slots that are `epochsBeforeFinal` epochs behind the current head (to avoid non-finalized data)
3. **Batch Processing**: Processes slots in batches of `batchSize` for efficiency
4. **Duty Checking**: For each slot, checks proposer duties and attestation duties for monitored validators
5. **Attestation Verification**: Verifies that validators submitted their attestations by checking aggregation bits
6. **Notification**: Sends Telegram notifications for any events (proposals, missed attestations, withdrawals)
7. **Progress Saving**: Automatically saves progress to `ethNotifier.json` after each batch

## Troubleshooting

### "Cannot connect to Lighthouse"
- Ensure Lighthouse is running and accessible
- Check that the Lighthouse URL is correct
- Verify that Lighthouse HTTP API is enabled (`--http` flag)

### "No attestations found" or missing data
- **CRITICAL**: Ensure Lighthouse is running with `--reconstruct-historic-states`
- Check that Lighthouse has fully synced
- Verify that your validators are active and have duties

### Telegram notifications not sending
- Verify your bot token is correct
- Ensure chat IDs are correct (use [@userinfobot](https://t.me/userinfobot) to get your chat ID)
- Check that the selected Telegram method is properly configured
- For `wrapper` method: ensure `telegram-cli-wrapper` is installed and executable

### High memory usage or OOM errors
- Reduce `batchSize` to process fewer slots at once
- Reduce `maxConcurrentRequests` to limit concurrent API calls (try 10)
- Increase `pollingInterval` to reduce polling frequency

## Project Structure

```
eth-notifier/
├── ethNotifier.js          # Main application entry point
├── lighthouse-api.js       # Lighthouse API wrapper with caching
├── cache.js                # Caching layer for API responses
├── telegram-bot-api.js     # Telegram notifications via Bot API
├── telegram-wrapper.js     # Telegram notifications via CLI wrapper
├── ethNotifier.json        # Configuration file
└── package.json            # Dependencies
```

## Dependencies

- `axios` - HTTP client for Lighthouse API
- `better-sqlite3` - SQLite database for caching
- `nconf` - Configuration management
- `node-emoji` - Emoji support for notifications
- `node-telegram-bot-api` - Official Telegram Bot API client

## License

MIT License - Feel free to use and modify as needed.

## Contributing

Contributions are welcome! Please feel free to submit issues or pull requests.

## Acknowledgments

- Built for the Ethereum community
- Uses the Lighthouse Beacon Node API
- MEV data from [beaconcha.in](https://beaconcha.in)
