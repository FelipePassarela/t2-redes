export class ABRController {
    constructor() {
        this.history = [];
        this.maxHistory = 5;
    }

    addSample(bytes, seconds) {
        if (seconds < 0) return;
        const tp = bytes / seconds;
        this.history.push(tp);
        if (this.history.length > this.maxHistory) {
            this.history.shift();
        }
    }

    getAvgThroughput() {
        if (this.history.length === 0) return null;
        return this.history.reduce((a, b) => a + b, 0) / this.history.length;
    }

    selectRepresentation(adaptations) {
        const avg = this.getAvgThroughput();
        if (!avg) return null;

        const target = avg * 0.75; // safety factor 75%
        const ordered = adaptations.slice().sort((a, b) => a.bandwidth - b.bandwidth);

        let best = ordered[0];
        for (const rep of ordered) {
            if (rep.bandwidth <= target) {
                best = rep;
            }
        }
        return best;
    }
}
