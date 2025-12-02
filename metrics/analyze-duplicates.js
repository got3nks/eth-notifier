#!/usr/bin/env node

/**
 * Analyze metrics for duplicate API requests
 */

const Database = require('better-sqlite3');
const path = require('path');

const DB_PATH = path.join(__dirname, 'lighthouse-metrics.db');
const db = new Database(DB_PATH, { readonly: true });

console.log('=== Analyzing Duplicate API Requests ===\n');

// Find duplicate requests (same full_uri called multiple times)
const duplicates = db.prepare(`
    SELECT
        endpoint,
        full_uri,
        COUNT(*) as count,
        MIN(timestamp) as first_request,
        MAX(timestamp) as last_request,
        ROUND((julianday(MAX(timestamp)) - julianday(MIN(timestamp))) * 86400000, 1) as time_diff_ms
    FROM api_requests
    GROUP BY full_uri
    HAVING count > 1
    ORDER BY count DESC, full_uri DESC
    LIMIT 50
`).all();

if (duplicates.length === 0) {
    console.log('✓ No duplicate requests found!');
} else {
    console.log(`Found ${duplicates.length} requests with duplicates:\n`);

    console.log('Endpoint'.padEnd(45) + ' | Full URI'.padEnd(50) + ' | Count | Time Between');
    console.log('-'.repeat(45) + '-+-' + '-'.repeat(50) + '-+-------+-------------');

    duplicates.forEach(row => {
        const endpoint = row.endpoint.padEnd(45);
        const uri = row.full_uri.substring(row.full_uri.lastIndexOf('/') + 1).padEnd(50);
        const count = String(row.count).padStart(5);
        const timeDiff = `${row.time_diff_ms}ms`;
        console.log(`${endpoint} | ${uri} | ${count} | ${timeDiff}`);
    });
}

// Summary statistics
const stats = db.prepare(`
    SELECT
        COUNT(DISTINCT full_uri) as unique_requests,
        COUNT(*) as total_requests,
        COUNT(*) - COUNT(DISTINCT full_uri) as duplicate_count
    FROM api_requests
`).get();

console.log('\n=== Summary ===');
console.log(`Unique API requests: ${stats.unique_requests}`);
console.log(`Total API requests: ${stats.total_requests}`);
console.log(`Duplicate requests: ${stats.duplicate_count}`);
if (stats.total_requests > 0) {
    const wastePercentage = (stats.duplicate_count / stats.total_requests * 100).toFixed(1);
    console.log(`Waste: ${wastePercentage}% of requests were duplicates`);
}

// Breakdown by endpoint
const endpointStats = db.prepare(`
    SELECT
        endpoint,
        COUNT(DISTINCT full_uri) as unique_requests,
        COUNT(*) as total_requests,
        COUNT(*) - COUNT(DISTINCT full_uri) as duplicate_count
    FROM api_requests
    GROUP BY endpoint
    HAVING duplicate_count > 0
    ORDER BY duplicate_count DESC
`).all();

if (endpointStats.length > 0) {
    console.log('\n=== Duplicates by Endpoint ===');
    endpointStats.forEach(row => {
        const wastePercentage = (row.duplicate_count / row.total_requests * 100).toFixed(1);
        console.log(`${row.endpoint}`);
        console.log(`  Unique: ${row.unique_requests}, Total: ${row.total_requests}, Duplicates: ${row.duplicate_count} (${wastePercentage}%)`);
    });
}

db.close();
