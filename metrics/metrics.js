/**
 * Metrics tracking for Lighthouse API calls
 * Logs all axios requests with timing, endpoint, and status information to SQLite
 */

const Database = require('better-sqlite3');
const path = require('path');

const DB_PATH = path.join(__dirname, 'lighthouse-metrics.db');

/**
 * Initialize SQLite database with metrics table
 */
function initDatabase() {
    const db = new Database(DB_PATH);

    db.exec(`
        CREATE TABLE IF NOT EXISTS api_requests (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            timestamp TEXT NOT NULL,
            endpoint TEXT NOT NULL,
            full_uri TEXT NOT NULL,
            method TEXT NOT NULL,
            status_code INTEGER,
            duration_ms REAL NOT NULL,
            error TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    `);

    // Create index on endpoint for faster queries
    db.exec(`
        CREATE INDEX IF NOT EXISTS idx_endpoint ON api_requests(endpoint);
        CREATE INDEX IF NOT EXISTS idx_timestamp ON api_requests(timestamp);
    `);

    return db;
}

/**
 * Convert a URL path to a parametric endpoint
 * Replaces dynamic parts (slot numbers, epoch numbers, etc.) with placeholders
 * Examples:
 *   /eth/v2/beacon/blocks/12345 -> /eth/v2/beacon/blocks/:slot
 *   /eth/v1/validator/duties/proposer/123 -> /eth/v1/validator/duties/proposer/:epoch
 */
function getParametricEndpoint(url) {
    try {
        const urlObj = new URL(url);
        let pathname = urlObj.pathname;

        // Replace slot numbers in block endpoints
        pathname = pathname.replace(/\/beacon\/blocks\/\d+/, '/beacon/blocks/:slot');

        // Replace epoch numbers in proposer duties
        pathname = pathname.replace(/\/duties\/proposer\/\d+/, '/duties/proposer/:epoch');

        // Replace slot numbers in states endpoints
        pathname = pathname.replace(/\/beacon\/states\/\d+/, '/beacon/states/:slot');

        // Replace validator indices
        pathname = pathname.replace(/\/validators\/\d+/, '/validators/:validator_index');

        return pathname;
    } catch (error) {
        // If URL parsing fails, return the original path
        return url;
    }
}

/**
 * Setup axios interceptors to track API metrics
 * @param {AxiosInstance} axiosInstance - The axios instance to monitor
 */
function setupMetrics(axiosInstance) {
    const db = initDatabase();

    // Prepare insert statement
    const insertStmt = db.prepare(`
        INSERT INTO api_requests (timestamp, endpoint, full_uri, method, status_code, duration_ms, error)
        VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    // Request interceptor - record start time
    axiosInstance.interceptors.request.use(
        (config) => {
            config.metadata = { startTime: Date.now() };
            return config;
        },
        (error) => {
            return Promise.reject(error);
        }
    );

    // Response interceptor - record completion and log to database
    axiosInstance.interceptors.response.use(
        (response) => {
            const duration = Date.now() - response.config.metadata.startTime;
            const timestamp = new Date().toISOString();
            const fullUri = response.config.url;
            const endpoint = getParametricEndpoint(fullUri);
            const method = (response.config.method || 'GET').toUpperCase();
            const statusCode = response.status;

            try {
                insertStmt.run(timestamp, endpoint, fullUri, method, statusCode, duration, null);
            } catch (error) {
                console.error('Error logging metrics:', error.message);
            }

            return response;
        },
        (error) => {
            // Log failed requests too
            const duration = error.config?.metadata?.startTime
                ? Date.now() - error.config.metadata.startTime
                : 0;
            const timestamp = new Date().toISOString();
            const fullUri = error.config?.url || 'unknown';
            const endpoint = getParametricEndpoint(fullUri);
            const method = (error.config?.method || 'GET').toUpperCase();
            const statusCode = error.response?.status || null;
            const errorMsg = error.message;

            try {
                insertStmt.run(timestamp, endpoint, fullUri, method, statusCode, duration, errorMsg);
            } catch (dbError) {
                console.error('Error logging metrics:', dbError.message);
            }

            return Promise.reject(error);
        }
    );

    console.log(`Metrics tracking initialized. Database: ${DB_PATH}`);

    return db;
}

/**
 * Query metrics from the database
 * Useful for generating reports
 */
function getMetrics(options = {}) {
    const db = new Database(DB_PATH, { readonly: true });

    const {
        endpoint = null,
        startDate = null,
        endDate = null,
        limit = 100
    } = options;

    let query = 'SELECT * FROM api_requests WHERE 1=1';
    const params = [];

    if (endpoint) {
        query += ' AND endpoint = ?';
        params.push(endpoint);
    }

    if (startDate) {
        query += ' AND timestamp >= ?';
        params.push(startDate);
    }

    if (endDate) {
        query += ' AND timestamp <= ?';
        params.push(endDate);
    }

    query += ' ORDER BY timestamp DESC LIMIT ?';
    params.push(limit);

    const stmt = db.prepare(query);
    const results = stmt.all(...params);

    db.close();
    return results;
}

/**
 * Get aggregated metrics by endpoint
 */
function getAggregatedMetrics(options = {}) {
    const db = new Database(DB_PATH, { readonly: true });

    const {
        startDate = null,
        endDate = null
    } = options;

    let query = `
        SELECT
            endpoint,
            COUNT(*) as total_requests,
            AVG(duration_ms) as avg_duration_ms,
            MIN(duration_ms) as min_duration_ms,
            MAX(duration_ms) as max_duration_ms,
            SUM(CASE WHEN status_code >= 200 AND status_code < 300 THEN 1 ELSE 0 END) as success_count,
            SUM(CASE WHEN status_code >= 400 OR error IS NOT NULL THEN 1 ELSE 0 END) as error_count
        FROM api_requests
        WHERE 1=1
    `;
    const params = [];

    if (startDate) {
        query += ' AND timestamp >= ?';
        params.push(startDate);
    }

    if (endDate) {
        query += ' AND timestamp <= ?';
        params.push(endDate);
    }

    query += ' GROUP BY endpoint ORDER BY total_requests DESC';

    const stmt = db.prepare(query);
    const results = stmt.all(...params);

    db.close();
    return results;
}

module.exports = {
    setupMetrics,
    getMetrics,
    getAggregatedMetrics,
    DB_PATH
};
