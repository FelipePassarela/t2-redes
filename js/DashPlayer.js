import { parseManifest } from "./parseManifest.js";

export class DashPlayer {
    constructor(videoElement, baseURL) {
        this.videoElement = videoElement;
        this.baseURL = baseURL;
        this.mediaSource = new MediaSource();
        this.sourceBuffer = null;

        // State variables
        this.manifest = null;
        this.representation = null;
        this.currentSegment = 1;
        this.isSeeking = false;

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
            console.log("Manifest loaded.");
            console.log("Adaptations:", adaptations);

            this.mediaSource.duration = totalDuration;
            // Hardcoded to first representation for simplicity
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
        if (this.isSeeking) return;
        if (this.mediaSource.readyState !== "open") return;

        const rep = this.representation;

        // Trick to capture currentSegment in async context
        const currentSegment = this.currentSegment;

        if (currentSegment > rep.nSegments) {
            if (this.mediaSource.readyState === "open") {
                this.mediaSource.endOfStream();
                console.log("End of stream reached.");
            }
            return;
        }

        try {
            console.log(`Fetching segment ${currentSegment} of ${rep.nSegments}`);
            await this.delay(500); // Simulate network delay

            const mediaURL = rep.mediaTemplate
                .replace("$RepresentationID$", rep.id)
                .replace("$Number$", currentSegment)
                .replace(".m4s", ""); // Server API doesn't expect file extension

            const resp = await fetch(mediaURL);
            if (!resp.ok) {
                throw new Error(`Failed to fetch segment: ${mediaURL}`);
            }
            const buffer = await resp.arrayBuffer();
            await this.appendBufferSafe(buffer);

            if (this.isSeeking) return;
            this.currentSegment++;
            this.feedNextSegment();

        } catch (error) {
            console.error("Error fetching/appending segment:", error);
        }
    }

    async delay(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    async onSeeking() {
        if (!this.sourceBuffer || !this.representation) return;

        const seekTime = this.videoElement.currentTime;
        console.log(`Seeking to ${seekTime.toFixed(2)}s`);
        this.isSeeking = true;

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
            this.isSeeking = false;
            return;
        }

        this.sourceBuffer.remove(0, Infinity);
        await new Promise(resolve => {
            this.sourceBuffer.addEventListener("updateend", resolve, { once: true });
        });
        this.currentSegment = segIndex + 1; // Segments are 1-indexed
        this.isSeeking = false;
        this.feedNextSegment();
    }
}
