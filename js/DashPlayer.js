import { parseManifest } from "./parseManifest.js";
import { ABRController } from "./ABRController.js";

export class DashPlayer {
    constructor(videoElement, baseURL, ui) {
        this.videoElement = videoElement;
        this.baseURL = baseURL;
        this.ui = ui;
        this.mediaSource = new MediaSource();
        this.sourceBuffer = null;
        this.abr = new ABRController();
        this.adaptations = null

        const minimalInBuffer = 10; // seconds

        // State variables
        this.representation = null;
        this.currentSegment = 1;
        this.seekSessionId = 0;

        this.onSourceOpen = this.onSourceOpen.bind(this);
        this.init();
    }

    init() {
        this.videoElement.src = URL.createObjectURL(this.mediaSource);
        this.mediaSource.addEventListener("sourceopen", this.onSourceOpen);
        this.videoElement.addEventListener("seeking", () => this.onSeeking());

        // Monitor buffer status
        setInterval(() => this.updateBufferStatus(), 500);
    }

    getBufferAhead() {
        if (!this.videoElement) return 0;
        const buffered = this.videoElement.buffered;
        const currentTime = this.videoElement.currentTime;
        let bufferAhead = 0;

        for (let i = 0; i < buffered.length; i++) {
            const start = buffered.start(i);
            const end = buffered.end(i);
            if (currentTime >= start && currentTime <= end) {
                bufferAhead = end - currentTime;
                break;
            }
        }
        return bufferAhead;
    }

    updateBufferStatus() {
        if (this.videoElement && this.ui) {
            const bufferAhead = this.getBufferAhead();
            this.ui.updateBuffer(bufferAhead);
        }
    }

    async onSourceOpen() {
        if (this.sourceBuffer) return; // Already initialized

        URL.revokeObjectURL(this.videoElement.src);

        try {
            const response = await fetch(this.baseURL + "manifest.mpd");
            const manifestText = await response.text();
            const [totalDuration, adaptations] = parseManifest(manifestText, this.baseURL);
            this.adaptations = adaptations;

            this.ui.log("Manifest loaded.");
            console.log("Adaptations:", adaptations);

            this.mediaSource.duration = totalDuration;
            this.representation = adaptations[0];
            this.ui.updateQuality(this.representation.id);

            const mimeType = `${this.representation.mimeType}; codecs="${this.representation.codecs}"`;
            this.sourceBuffer = this.mediaSource.addSourceBuffer(mimeType);
            const initResp = await fetch(this.representation.init);
            const initBuffer = await initResp.arrayBuffer();
            await this.appendBufferSafe(initBuffer);

            this.feedNextSegment();
        } catch (error) {
            this.ui.log(`Error during source open: ${error.message}`);
        }
    }

    async appendBufferSafe(buffer) {
        if (!this.sourceBuffer) return;

        if (this.sourceBuffer.updating) {
            await new Promise(resolve => {
                this.sourceBuffer.addEventListener("updateend", resolve, { once: true });
            });
        }

        this.sourceBuffer.appendBuffer(buffer);

        // Wait for the append to finish
        return new Promise(resolve => {
            this.sourceBuffer.addEventListener("updateend", resolve, { once: true });
        });
    }

    async feedNextSegment() {
        const mySessionId = this.seekSessionId;

        if (this.mediaSource.readyState !== "open") return;

        // Check buffer level
        const bufferAhead = this.getBufferAhead();
        if (bufferAhead >= this.minimalInBuffer) {
            ui.log("Buffer full, waiting...");
            setTimeout(() => {
                if (this.seekSessionId === mySessionId) {
                    this.feedNextSegment();
                }
            }, 1000);
            return;
        }

        const rep = this.representation;
        const currentSeg = this.currentSegment; // Local var to avoid race conditions

        if (currentSeg > rep.nSegments) {
            if (this.mediaSource.readyState === "open") {
                this.mediaSource.endOfStream();
                this.ui.log("End of stream reached.");
            }
            return;
        }

        if (this.isSegmentBuffered(currentSeg)) {
            this.currentSegment++;
            this.feedNextSegment();
            return;
        }

        try {
            this.ui.log(`Fetching segment ${currentSeg} of ${rep.nSegments}`);

            await this.delay(2500); // Simulate network delay
            if (mySessionId !== this.seekSessionId) return;

            const mediaURL = rep.mediaTemplate
                .replace("$RepresentationID$", rep.id)
                .replace("$Number$", this.currentSegment)
                .replace(".m4s", ""); // Server API doesn't expect file extension

            const startDownloadTime = performance.now();
            const resp = await fetch(mediaURL);
            const buffer = await resp.arrayBuffer();
            const endDownloadTime = performance.now();
            if (mySessionId !== this.seekSessionId) return;

            // eval ABR
            const timeToDownload = (endDownloadTime - startDownloadTime) / 1000;
            const mbps = (buffer.byteLength * 8) / (timeToDownload * 1000000);
            this.ui.updateSpeed(mbps);

            this.abr.addSample(buffer.byteLength, timeToDownload);
            const bestRepr = this.abr.selectRepresentation(this.adaptations);
            if (bestRepr && bestRepr.id !== this.representation.id) {
                await this.switchRepresentation(bestRepr);
                return;
            }

            await this.appendBufferSafe(buffer);
            if (mySessionId !== this.seekSessionId) return;

            this.currentSegment++;
            this.feedNextSegment();

        } catch (error) {
            // Ignore aborted fetches due to seeking
            if (mySessionId !== this.seekSessionId) return;
            this.ui.log(`Error fetching/appending segment: ${error.message}`);
        }
    }

    async delay(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    async onSeeking() {
        if (!this.sourceBuffer || !this.representation) return;

        this.seekSessionId++;

        const seekTime = this.videoElement.currentTime;
        this.ui.log(`Seeking to ${seekTime.toFixed(2)}s`);

        // Find the segment that contains the seekTime
        if (this.sourceBuffer.updating) {
            await new Promise(resolve => {
                this.sourceBuffer.addEventListener("updateend", resolve, { once: true });
            });
        }

        const segIndex = this.representation.segments.findIndex(seg => {
            const endTime = seg.start + seg.duration;
            return seekTime >= seg.start && seekTime < endTime;
        });

        if (segIndex === -1) {
            console.warn("Seek time out of range of available segments.");
            this.seekSessionId--;
            return;
        }

        if (this.isSegmentBuffered(segIndex + 1)) {
            this.currentSegment = segIndex + 1;
            this.feedNextSegment();
            return;
        }

        this.sourceBuffer.remove(0, Infinity);
        await new Promise(resolve => {
            this.sourceBuffer.addEventListener("updateend", resolve, { once: true });
        });
        this.currentSegment = segIndex + 1; // Segments are 1-indexed
        this.feedNextSegment();
    }

    isSegmentBuffered(segmentNumber) {
        if (!this.sourceBuffer || !this.representation) return false;

        const segmentInfo = this.representation.segments[segmentNumber - 1];

        if (!segmentInfo) return false;

        const segStart = segmentInfo.start;
        const segEnd = segmentInfo.start + segmentInfo.duration;
        const buffered = this.sourceBuffer.buffered;
        const tolerance = 0.1; // to avoid floating point issues

        for (let i = 0; i < buffered.length; i++) {
            const buffStart = buffered.start(i);
            const buffEnd = buffered.end(i);

            if ((segStart + tolerance) >= buffStart && (segEnd - tolerance) <= buffEnd) {
                return true;
            }
        }

        return false;
    }

    async switchRepresentation(newRepresentation) {
        const mySessionId = this.seekSessionId;

        this.sourceBuffer.remove(0, Infinity);
        await new Promise(resolve => this.sourceBuffer
            .addEventListener("updateend", resolve, { once: true })
        );
        if (mySessionId !== this.seekSessionId) return;

        const initResp = await fetch(newRepresentation.init)
        const initBuffer = await initResp.arrayBuffer();
        if (mySessionId !== this.seekSessionId) return;
        await this.appendBufferSafe(initBuffer);
        if (mySessionId !== this.seekSessionId) return;

        const segToFetch = newRepresentation.segments.findIndex(seg => {
            const endTime = seg.start + seg.duration;
            return this.videoElement.currentTime >= seg.start &&
                this.videoElement.currentTime < endTime;
        });

        if (segToFetch === -1) {
            console.warn("Seek time out of range of available segments.");
            return;
        }

        this.representation = newRepresentation
        this.currentSegment = segToFetch + 1;
        this.ui.log(`Switched to ${newRepresentation.id}`);
        this.ui.updateQuality(newRepresentation.id);
        this.feedNextSegment();
    }
}
