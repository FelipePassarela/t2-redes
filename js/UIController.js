export class UIController {
    constructor() {
        this.qualityElement = document.getElementById('quality-value');
        this.bufferElement = document.getElementById('buffer-value');
        this.speedElement = document.getElementById('speed-value');
        this.logsContainer = document.getElementById('logs-content');
    }

    updateQuality(quality) {
        if (this.qualityElement) {
            this.qualityElement.textContent = quality;
        }
    }

    updateBuffer(bufferTime) {
        if (this.bufferElement) {
            this.bufferElement.textContent = bufferTime.toFixed(2) + 's';
        }
    }

    updateSpeed(mbps) {
        if (this.speedElement) {
            this.speedElement.textContent = mbps.toFixed(2) + ' Mbps';
        }
    }

    log(message) {
        console.log(message);
        if (this.logsContainer) {
            const logEntry = document.createElement('div');
            logEntry.className = 'log-entry';
            logEntry.textContent = `[${new Date().toLocaleTimeString()}] ${message}`;
            this.logsContainer.prepend(logEntry);

            // Limit logs to 50 entries to prevent performance issues
            if (this.logsContainer.children.length > 50) {
                this.logsContainer.removeChild(this.logsContainer.lastChild);
            }
        }
    }
}
