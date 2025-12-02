# Lighthouse API Metrics

Automatic tracking of all Lighthouse Beacon API calls made by eth-notifier.

## How It Works

All axios HTTP requests to the Lighthouse API are automatically logged to a SQLite database (`lighthouse-metrics.db`) with:
- Timestamp
- Parametric endpoint (e.g., `/eth/v2/beacon/blocks/:slot`)
- Full URI
- HTTP method
- Status code
- Duration in milliseconds
- Error message (if failed)

## Viewing Metrics

### Aggregated Summary (default)
```bash
node view-metrics.js
```

Shows metrics grouped by endpoint with:
- Total requests
- Success count
- Error count
- Average/min/max duration

### Recent Requests
```bash
# Show 20 most recent
node view-metrics.js --recent

# Show 50 most recent
node view-metrics.js --recent 50
```

### Filter by Endpoint
```bash
node view-metrics.js --endpoint /eth/v2/beacon/blocks/:slot
```

### Export to CSV
```bash
node view-metrics.js --export metrics.csv
```

## Database Location

`lighthouse-metrics.db` in the project root directory.

## Querying Directly with SQLite

```bash
# View schema
sqlite3 lighthouse-metrics.db ".schema"

# Recent requests
sqlite3 lighthouse-metrics.db "SELECT * FROM api_requests ORDER BY timestamp DESC LIMIT 10"

# Slowest requests
sqlite3 lighthouse-metrics.db "SELECT endpoint, full_uri, duration_ms FROM api_requests ORDER BY duration_ms DESC LIMIT 10"

# Requests by hour
sqlite3 lighthouse-metrics.db "SELECT strftime('%Y-%m-%d %H:00', timestamp) as hour, COUNT(*) FROM api_requests GROUP BY hour"

# Error rate by endpoint
sqlite3 lighthouse-metrics.db "SELECT endpoint, COUNT(*) as total, SUM(CASE WHEN error IS NOT NULL THEN 1 ELSE 0 END) as errors FROM api_requests GROUP BY endpoint"
```

## Implementation Details

- **metrics.js**: Core metrics tracking with axios interceptors
- **view-metrics.js**: CLI tool for viewing metrics
- **lighthouse-api.js**: Initializes metrics on startup (line 8-11)

Metrics tracking adds minimal overhead (<1ms per request) and handles concurrent requests safely.
