import { parseManifest } from "./parseManifest.js";
import { ABRController } from "./ABRController.js";

export class DashPlayer {
    constructor(videoElement, baseURL) {
        this.videoElement = videoElement;
        this.baseURL = baseURL;
        this.mediaSource = new MediaSource();
        this.sourceBuffer = null;
        this.abr = new ABRController();
        this.adaptations = null

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
    }

    async onSourceOpen() {
        if (this.sourceBuffer) return; // Already initialized

        URL.revokeObjectURL(this.videoElement.src);

        try {
            const response = await fetch(this.baseURL + "manifest.mpd");
            const manifestText = await response.text();
            const [totalDuration, adaptations] = parseManifest(manifestText, this.baseURL);
            this.adaptations = adaptations;
            console.log("Manifest loaded.");
            console.log("Adaptations:", adaptations);

            this.mediaSource.duration = totalDuration;
            this.representation = adaptations[0];

            const mimeType = `${this.representation.mimeType}; codecs="${this.representation.codecs}"`;
            this.sourceBuffer = this.mediaSource.addSourceBuffer(mimeType);
            const initResp = await fetch(this.representation.init);
            const initBuffer = await initResp.arrayBuffer();
            await this.appendBufferSafe(initBuffer);

            this.feedNextSegment();
        } catch (error) {
            console.error("Error during source open:", error);
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

        const rep = this.representation;
        const currentSeg = this.currentSegment; // Local var to avoid race conditions

        if (currentSeg > rep.nSegments) {
            if (this.mediaSource.readyState === "open") {
                this.mediaSource.endOfStream();
                console.log("End of stream reached.");
            }
            return;
        }

        if (this.isSegmentBuffered(currentSeg)) {
            this.currentSegment++;
            this.feedNextSegment();
            return;
        }

        try {
            console.log(`Fetching segment ${currentSeg} of ${rep.nSegments}`);

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
            console.error("Error fetching/appending segment:", error);
        }
    }

    async delay(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    async onSeeking() {
        if (!this.sourceBuffer || !this.representation) return;

        this.seekSessionId++;

        const seekTime = this.videoElement.currentTime;
        console.log(`Seeking to ${seekTime.toFixed(2)}s`);

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
        console.log(`Switched to ${newRepresentation.id}`)
        this.feedNextSegment();
    }
}
