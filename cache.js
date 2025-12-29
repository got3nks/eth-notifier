/**
 * Simple in-memory cache for Lighthouse API responses
 * Blocks and committees are immutable once finalized, so we can cache them aggressively
 */

class LighthouseCache {
    constructor(options = {}) {
        this.maxSize = options.maxSize || 10000; // Max items to cache
        this.ttl = options.ttl || 3600000; // 1 hour default TTL

        this.blocks = new Map(); // slot -> block data
        this.slotCommittees = new Map(); // slot -> all committees for that slot

        this.hits = { blocks: 0, slotCommittees: 0 };
        this.misses = { blocks: 0, slotCommittees: 0 };

        // Start periodic cleanup to remove expired entries
        this.cleanupInterval = setInterval(() => {
            this._cleanupExpired();
        }, options.cleanupInterval || 3600000); // Run every hour by default
    }

    // Block cache methods
    hasBlock(slot) {
        return this.blocks.has(slot);
    }

    getBlock(slot) {
        const entry = this.blocks.get(slot);
        if (entry && (Date.now() - entry.timestamp < this.ttl)) {
            this.hits.blocks++;
            return entry.data;
        }
        this.misses.blocks++;
        return null;
    }

    setBlock(slot, blockData) {
        this._enforceSize(this.blocks);
        this.blocks.set(slot, {
            data: blockData,
            timestamp: Date.now()
        });
    }

    // Slot committees cache (used by getAttestations and getAttestationDuties)
    hasSlotCommittees(slot) {
        return this.slotCommittees.has(slot);
    }

    getSlotCommittees(slot) {
        const entry = this.slotCommittees.get(slot);
        if (entry && (Date.now() - entry.timestamp < this.ttl)) {
            this.hits.slotCommittees++;
            return entry.data;
        }
        this.misses.slotCommittees++;
        return null;
    }

    setSlotCommittees(slot, committeesData) {
        this._enforceSize(this.slotCommittees);
        this.slotCommittees.set(slot, {
            data: committeesData,
            timestamp: Date.now()
        });
    }

    // Clear old entries if cache is getting too large
    _enforceSize(cache) {
        if (cache.size >= this.maxSize) {
            // Remove oldest 10% of entries
            const toRemove = Math.floor(this.maxSize * 0.1);
            const keys = Array.from(cache.keys()).slice(0, toRemove);
            keys.forEach(key => cache.delete(key));
        }
    }

    // Remove expired entries from all caches
    _cleanupExpired() {
        const now = Date.now();
        let removedBlocks = 0;
        let removedCommittees = 0;

        // Clean blocks cache
        for (const [key, entry] of this.blocks.entries()) {
            if (now - entry.timestamp >= this.ttl) {
                this.blocks.delete(key);
                removedBlocks++;
            }
        }

        // Clean committees cache
        for (const [key, entry] of this.slotCommittees.entries()) {
            if (now - entry.timestamp >= this.ttl) {
                this.slotCommittees.delete(key);
                removedCommittees++;
            }
        }

        if (removedBlocks > 0 || removedCommittees > 0) {
            console.log(`Cache cleanup: removed ${removedBlocks} expired blocks, ${removedCommittees} expired committees`);
        }
    }

    // Clear all caches
    clear() {
        this.blocks.clear();
        this.slotCommittees.clear();
        this.hits = { blocks: 0, slotCommittees: 0 };
        this.misses = { blocks: 0, slotCommittees: 0 };
    }

    // Stop cleanup interval (call when shutting down)
    destroy() {
        if (this.cleanupInterval) {
            clearInterval(this.cleanupInterval);
            this.cleanupInterval = null;
        }
    }

    // Get cache statistics
    getStats() {
        const totalHits = this.hits.blocks + this.hits.slotCommittees;
        const totalMisses = this.misses.blocks + this.misses.slotCommittees;
        const totalRequests = totalHits + totalMisses;
        const hitRate = totalRequests > 0 ? (totalHits / totalRequests * 100).toFixed(2) : 0;

        return {
            blocks: {
                cached: this.blocks.size,
                hits: this.hits.blocks,
                misses: this.misses.blocks,
                hitRate: this.misses.blocks + this.hits.blocks > 0
                    ? ((this.hits.blocks / (this.misses.blocks + this.hits.blocks)) * 100).toFixed(2) + '%'
                    : 'N/A'
            },
            slotCommittees: {
                cached: this.slotCommittees.size,
                hits: this.hits.slotCommittees,
                misses: this.misses.slotCommittees,
                hitRate: this.misses.slotCommittees + this.hits.slotCommittees > 0
                    ? ((this.hits.slotCommittees / (this.misses.slotCommittees + this.hits.slotCommittees)) * 100).toFixed(2) + '%'
                    : 'N/A'
            },
            overall: {
                hitRate: hitRate + '%',
                totalHits,
                totalMisses
            }
        };
    }

    // Pretty print stats
    printStats() {
        const stats = this.getStats();
        console.log('\n=== Cache Statistics ===');
        console.log(`Blocks: ${stats.blocks.cached} cached, ${stats.blocks.hits} hits, ${stats.blocks.misses} misses (${stats.blocks.hitRate} hit rate)`);
        console.log(`Slot committees: ${stats.slotCommittees.cached} cached, ${stats.slotCommittees.hits} hits, ${stats.slotCommittees.misses} misses (${stats.slotCommittees.hitRate} hit rate)`);
        console.log(`Overall hit rate: ${stats.overall.hitRate}`);
        console.log('========================\n');
    }
}

module.exports = new LighthouseCache({
    maxSize: 2000,           // Keep up to 2k items
    ttl: 1800000,            // 30 minutes
    cleanupInterval: 600000  // 10 minutes
});
