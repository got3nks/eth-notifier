#!/usr/bin/env node

/**
 * CLI tool to view Lighthouse API metrics
 *
 * Usage:
 *   node view-metrics.js                    # Show aggregated metrics
 *   node view-metrics.js --recent           # Show 20 most recent requests
 *   node view-metrics.js --recent 50        # Show 50 most recent requests
 *   node view-metrics.js --endpoint <path>  # Filter by endpoint
 *   node view-metrics.js --export metrics.csv  # Export to CSV
 */

const metrics = require('./metrics');
const fs = require('fs');

const args = process.argv.slice(2);

function formatDuration(ms) {
    if (ms < 1000) return `${ms.toFixed(1)}ms`;
    return `${(ms / 1000).toFixed(2)}s`;
}

function printTable(rows, headers) {
    if (rows.length === 0) {
        console.log('No data found.');
        return;
    }

    // Calculate column widths
    const widths = {};
    headers.forEach(h => {
        widths[h] = h.length;
    });

    rows.forEach(row => {
        headers.forEach(h => {
            const val = String(row[h] || '');
            widths[h] = Math.max(widths[h], val.length);
        });
    });

    // Print header
    const headerRow = headers.map(h => h.padEnd(widths[h])).join(' | ');
    console.log(headerRow);
    console.log(headers.map(h => '-'.repeat(widths[h])).join('-+-'));

    // Print rows
    rows.forEach(row => {
        const rowStr = headers.map(h => {
            const val = String(row[h] || '');
            return val.padEnd(widths[h]);
        }).join(' | ');
        console.log(rowStr);
    });
}

function showAggregated() {
    console.log('=== Lighthouse API Metrics - Aggregated by Endpoint ===\n');

    const results = metrics.getAggregatedMetrics();

    if (results.length === 0) {
        console.log('No metrics data found. Make some API requests first.');
        return;
    }

    const formatted = results.map(r => ({
        endpoint: r.endpoint,
        total: r.total_requests,
        success: r.success_count,
        errors: r.error_count,
        avg_ms: r.avg_duration_ms.toFixed(1),
        min_ms: r.min_duration_ms.toFixed(1),
        max_ms: r.max_duration_ms.toFixed(1)
    }));

    printTable(formatted, ['endpoint', 'total', 'success', 'errors', 'avg_ms', 'min_ms', 'max_ms']);

    // Summary
    const totalRequests = results.reduce((sum, r) => sum + r.total_requests, 0);
    const totalErrors = results.reduce((sum, r) => sum + r.error_count, 0);
    const avgDuration = results.reduce((sum, r) => sum + (r.avg_duration_ms * r.total_requests), 0) / totalRequests;

    console.log(`\n=== Summary ===`);
    console.log(`Total Requests: ${totalRequests}`);
    console.log(`Success Rate: ${((totalRequests - totalErrors) / totalRequests * 100).toFixed(2)}%`);
    console.log(`Overall Avg Duration: ${formatDuration(avgDuration)}`);
}

function showRecent(limit = 20, endpoint = null) {
    console.log(`=== ${limit} Most Recent API Requests ===\n`);

    const results = metrics.getMetrics({ limit, endpoint });

    if (results.length === 0) {
        console.log('No metrics data found.');
        return;
    }

    const formatted = results.map(r => ({
        timestamp: new Date(r.timestamp).toLocaleString(),
        endpoint: r.endpoint,
        status: r.status_code || 'ERR',
        duration: formatDuration(r.duration_ms),
        error: r.error ? r.error.substring(0, 40) : ''
    }));

    printTable(formatted, ['timestamp', 'endpoint', 'status', 'duration', 'error']);
}

function exportToCSV(filename) {
    console.log(`Exporting all metrics to ${filename}...`);

    const results = metrics.getMetrics({ limit: 1000000 });

    if (results.length === 0) {
        console.log('No data to export.');
        return;
    }

    const headers = ['timestamp', 'endpoint', 'full_uri', 'method', 'status_code', 'duration_ms', 'error'];
    const csv = [
        headers.join(','),
        ...results.map(r => headers.map(h => {
            const val = r[h] || '';
            // Escape commas and quotes
            if (typeof val === 'string' && (val.includes(',') || val.includes('"'))) {
                return `"${val.replace(/"/g, '""')}"`;
            }
            return val;
        }).join(','))
    ].join('\n');

    fs.writeFileSync(filename, csv, 'utf8');
    console.log(`Exported ${results.length} records to ${filename}`);
}

// Parse arguments
if (args.includes('--help') || args.includes('-h')) {
    console.log(`
Lighthouse API Metrics Viewer

Usage:
  node view-metrics.js                    # Show aggregated metrics
  node view-metrics.js --recent           # Show 20 most recent requests
  node view-metrics.js --recent 50        # Show 50 most recent requests
  node view-metrics.js --endpoint <path>  # Filter by endpoint
  node view-metrics.js --export <file>    # Export all data to CSV

Examples:
  node view-metrics.js
  node view-metrics.js --recent 100
  node view-metrics.js --endpoint /eth/v2/beacon/blocks/:slot
  node view-metrics.js --export metrics.csv
    `);
    process.exit(0);
}

if (args.includes('--export')) {
    const idx = args.indexOf('--export');
    const filename = args[idx + 1] || 'metrics.csv';
    exportToCSV(filename);
} else if (args.includes('--recent')) {
    const idx = args.indexOf('--recent');
    const limit = parseInt(args[idx + 1]) || 20;
    const endpointIdx = args.indexOf('--endpoint');
    const endpoint = endpointIdx >= 0 ? args[endpointIdx + 1] : null;
    showRecent(limit, endpoint);
} else if (args.includes('--endpoint')) {
    const idx = args.indexOf('--endpoint');
    const endpoint = args[idx + 1];
    showRecent(100, endpoint);
} else {
    showAggregated();
}
