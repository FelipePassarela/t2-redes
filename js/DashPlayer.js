import { parseManifest } from "./parseManifest.js";
import { ABRController } from "./ABRController.js";

export class DashPlayer {
    constructor(videoElement, baseURL, ui) {
        this.videoElement = videoElement;
        this.baseURL = baseURL;
        this.ui = ui;
        this.mediaSource = new MediaSource();
        this.abr = new ABRController();

        this.videoSourceBuffer = null;
        this.videoAdaptations = null;
        this.audioSourceBuffer = null;
        this.audioAdaptations = null;

        this.delayMs = 1750; // ms
        this.minimumBufferTime = 4 * this.delayMs / (1000); // seconds
        this.defaultVolume = 0.1;
        console.log("Minimal in buffer:", this.minimumBufferTime);

        // State variables
        this.videoRepresentation = null;
        this.audioRepresentation = null;

        this.currentVideoSegment = 1;
        this.currentAudioSegment = 1;

        this.seekSessionId = 0;
        this.isInitializing = false;

        this.onSourceOpen = this.onSourceOpen.bind(this);
        this.init();
    }

    init() {
        this.videoElement.src = URL.createObjectURL(this.mediaSource);
        this.videoElement.volume = this.defaultVolume;
        this.mediaSource.addEventListener("sourceopen", this.onSourceOpen);
        this.videoElement.addEventListener("seeking", () => this.onSeeking());

        // Monitor buffer status
        setInterval(() => this.updateBufferStatus(), 500);
    }

    getBufferAhead(type = 'video') {
        if (!this.videoElement) return 0;
        const buffered = this.videoElement.buffered; // This is the combined buffered range
        // Ideally we should check sourceBuffer.buffered but videoElement.buffered is usually the intersection or union depending on browser
        // For precise control, let's check the specific source buffer if possible, but standard API is on videoElement or sourceBuffer

        let sb = type === 'video' ? this.videoSourceBuffer : this.audioSourceBuffer;
        if (!sb) return 0;

        const currentTime = this.videoElement.currentTime;
        let bufferAhead = 0;

        const sbBuffered = sb.buffered;

        for (let i = 0; i < sbBuffered.length; i++) {
            const start = sbBuffered.start(i);
            const end = sbBuffered.end(i);
            if (currentTime >= start && currentTime <= end) {
                bufferAhead = end - currentTime;
                break;
            }
        }
        return bufferAhead;
    }

    updateBufferStatus() {
        if (this.videoElement && this.ui) {
            const bufferAhead = this.getBufferAhead('video'); // Show video buffer for now
            this.ui.updateBuffer(bufferAhead);
        }
    }

    async onSourceOpen() {
        if (this.isInitializing || this.videoSourceBuffer || this.audioSourceBuffer) return;
        this.isInitializing = true;

        URL.revokeObjectURL(this.videoElement.src);

        try {
            const response = await fetch(this.baseURL + "manifest.mpd");
            const manifestText = await response.text();
            const [totalDuration, videoAdaptations, audioAdaptations] = parseManifest(manifestText, this.baseURL);

            this.videoAdaptations = videoAdaptations;
            this.audioAdaptations = audioAdaptations;

            this.ui.log("Manifest loaded.");
            console.log("Video Adaptations:", videoAdaptations);
            console.log("Audio Adaptations:", audioAdaptations);

            this.mediaSource.duration = totalDuration;

            // 1. Create SourceBuffers first
            if (this.videoAdaptations.length > 0) {
                this.videoRepresentation = this.videoAdaptations[0];
                const mimeType = `${this.videoRepresentation.mimeType}; codecs="${this.videoRepresentation.codecs}"`;
                console.log(`Adding video SourceBuffer: ${mimeType}`);

                if (MediaSource.isTypeSupported(mimeType)) {
                    this.videoSourceBuffer = this.mediaSource.addSourceBuffer(mimeType);
                } else {
                    this.ui.log(`Video codec not supported: ${mimeType}`);
                }
            }

            if (this.audioAdaptations.length > 0) {
                this.audioRepresentation = this.audioAdaptations[0];
                const mimeType = `${this.audioRepresentation.mimeType}; codecs="${this.audioRepresentation.codecs}"`;
                console.log(`Adding audio SourceBuffer: ${mimeType}`);

                if (MediaSource.isTypeSupported(mimeType)) {
                    this.audioSourceBuffer = this.mediaSource.addSourceBuffer(mimeType);
                } else {
                    this.ui.log(`Audio codec not supported: ${mimeType}`);
                }
            }

            // 2. Initialize Buffers
            if (this.videoSourceBuffer) {
                this.ui.updateQuality(this.videoRepresentation.height + "p");
                const initResp = await fetch(this.videoRepresentation.init);
                const initBuffer = await initResp.arrayBuffer();
                await this.appendBufferSafe(this.videoSourceBuffer, initBuffer);
            }

            if (this.audioSourceBuffer) {
                const initResp = await fetch(this.audioRepresentation.init);
                const initBuffer = await initResp.arrayBuffer();
                await this.appendBufferSafe(this.audioSourceBuffer, initBuffer);
            }

            this.feedNextVideoSegment();
            this.feedNextAudioSegment();
        } catch (error) {
            this.ui.log(`Error during source open: ${error.message}`);
            console.error(error);
        } finally {
            this.isInitializing = false;
        }
    }

    async appendBufferSafe(sourceBuffer, buffer) {
        if (!sourceBuffer) return;

        if (sourceBuffer.updating) {
            await new Promise(resolve => {
                sourceBuffer.addEventListener("updateend", resolve, { once: true });
            });
        }

        sourceBuffer.appendBuffer(buffer);

        // Wait for the append to finish
        return new Promise(resolve => {
            sourceBuffer.addEventListener("updateend", resolve, { once: true });
        });
    }

    async feedNextVideoSegment() {
        const mySessionId = this.seekSessionId;

        if (this.mediaSource.readyState !== "open") return;

        // Check buffer level
        const bufferAhead = this.getBufferAhead('video');
        if (bufferAhead >= this.minimumBufferTime) {
            this.ui.log("Buffer full, waiting...");
            setTimeout(() => {
                if (this.seekSessionId === mySessionId) {
                    this.feedNextVideoSegment();
                }
            }, this.delayMs);
            return;
        }

        const rep = this.videoRepresentation;
        const currentSeg = this.currentVideoSegment;

        if (currentSeg > rep.nSegments) {
            this.checkEndOfStream();
            return;
        }

        if (this.isSegmentBuffered(currentSeg, 'video')) {
            this.currentVideoSegment++;
            this.feedNextVideoSegment();
            return;
        }

        try {
            this.ui.log(`Fetching Video segment ${currentSeg} of ${rep.nSegments}`);

            await this.delay(this.delayMs);
            if (mySessionId !== this.seekSessionId) return;

            const mediaURL = rep.mediaTemplate
                .replace("$RepresentationID$", rep.id)
                .replace("$Number$", this.currentVideoSegment)
                .replace(".m4s", "");

            const startDownloadTime = performance.now();
            const resp = await fetch(mediaURL);
            const buffer = await resp.arrayBuffer();
            const endDownloadTime = performance.now();
            if (mySessionId !== this.seekSessionId) return;

            await this.appendBufferSafe(this.videoSourceBuffer, buffer);
            if (mySessionId !== this.seekSessionId) return;
            this.currentVideoSegment++;

            // eval ABR
            const timeToDownload = (endDownloadTime - startDownloadTime) / 1000;
            this.abr.addSample(buffer.byteLength, timeToDownload);

            // Simulate noisy network by picking a random representation
            const bestRepr = this.randomRepresentation();
            const randFactor = Math.random() * 0.5 + 0.75;
            const mbps = randFactor * bestRepr.bandwidth / 1000000;
            this.ui.updateSpeed(mbps);

            if (bestRepr && bestRepr.id !== this.videoRepresentation.id) {
                await this.switchRepresentation(bestRepr);
                if (mySessionId !== this.seekSessionId) return;
            }

            this.feedNextVideoSegment();

        } catch (error) {
            if (mySessionId !== this.seekSessionId) return;
            this.ui.log(`Error fetching/appending video segment: ${error.message}`);
        }
    }

    async feedNextAudioSegment() {
        const mySessionId = this.seekSessionId;

        if (this.mediaSource.readyState !== "open") return;
        if (!this.audioRepresentation) return;

        // Check buffer level
        const bufferAhead = this.getBufferAhead('audio');
        if (bufferAhead >= this.minimumBufferTime) {
            setTimeout(() => {
                if (this.seekSessionId === mySessionId) {
                    this.feedNextAudioSegment();
                }
            }, this.delayMs);
            return;
        }

        const rep = this.audioRepresentation;
        const currentSeg = this.currentAudioSegment;

        if (currentSeg > rep.nSegments) {
            this.checkEndOfStream();
            return;
        }

        if (this.isSegmentBuffered(currentSeg, 'audio')) {
            this.currentAudioSegment++;
            this.feedNextAudioSegment();
            return;
        }

        try {
            // this.ui.log(`Fetching Audio segment ${currentSeg}`);

            await this.delay(this.delayMs);
            if (mySessionId !== this.seekSessionId) return;

            const mediaURL = rep.mediaTemplate
                .replace("$RepresentationID$", rep.id)
                .replace("$Number$", this.currentAudioSegment)
                .replace(".m4s", "");

            const resp = await fetch(mediaURL);
            const buffer = await resp.arrayBuffer();
            if (mySessionId !== this.seekSessionId) return;

            await this.appendBufferSafe(this.audioSourceBuffer, buffer);
            if (mySessionId !== this.seekSessionId) return;
            this.currentAudioSegment++;

            this.feedNextAudioSegment();

        } catch (error) {
            if (mySessionId !== this.seekSessionId) return;
            this.ui.log(`Error fetching/appending audio segment: ${error.message}`);
        }
    }

    checkEndOfStream() {
        const videoDone = !this.videoRepresentation || this.currentVideoSegment > this.videoRepresentation.nSegments;
        const audioDone = !this.audioRepresentation || this.currentAudioSegment > this.audioRepresentation.nSegments;

        if (videoDone && audioDone && this.mediaSource.readyState === "open") {
            this.mediaSource.endOfStream();
            this.ui.log("End of stream reached.");
        }
    }

    randomRepresentation() {
        const index = Math.floor(Math.random() * this.videoAdaptations.length);
        return this.videoAdaptations[index];
    }

    async delay(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    async onSeeking() {
        if (!this.videoSourceBuffer || !this.videoRepresentation) return;

        this.seekSessionId++;
        const mySessionId = this.seekSessionId;

        const seekTime = this.videoElement.currentTime;
        this.ui.log(`Seeking to ${seekTime.toFixed(2)}s`);

        // Wait for updates to finish
        if (this.videoSourceBuffer.updating) {
            await new Promise(resolve => this.videoSourceBuffer.addEventListener("updateend", resolve, { once: true }));
        }
        if (this.audioSourceBuffer && this.audioSourceBuffer.updating) {
            await new Promise(resolve => this.audioSourceBuffer.addEventListener("updateend", resolve, { once: true }));
        }

        if (mySessionId !== this.seekSessionId) return;

        // Find the segment that contains the seekTime
        const vidSegIndex = this.videoRepresentation.segments.findIndex(seg => {
            const endTime = seg.start + seg.duration;
            return seekTime >= seg.start && seekTime < endTime;
        });

        if (vidSegIndex === -1) {
            console.warn("Seek time out of range of available segments.");
            // Do not decrement seekSessionId here as we already started a new one
            return;
        }

        // Check if the seek target is already buffered
        const isTimeBuffered = (buffer, time) => {
            if (!buffer) return false;
            const buffered = buffer.buffered;
            for (let i = 0; i < buffered.length; i++) {
                if (time >= buffered.start(i) && time <= buffered.end(i)) {
                    return true;
                }
            }
            return false;
        };

        const videoHasData = isTimeBuffered(this.videoSourceBuffer, seekTime);

        let audSegIndex = -1;
        if (this.audioRepresentation) {
            audSegIndex = this.audioRepresentation.segments.findIndex(seg => {
                const endTime = seg.start + seg.duration;
                return seekTime >= seg.start && seekTime < endTime;
            });
        }

        if (videoHasData) {
            this.currentVideoSegment = vidSegIndex + 1;
            if (audSegIndex !== -1) this.currentAudioSegment = audSegIndex + 1;

            this.feedNextVideoSegment();
            this.feedNextAudioSegment();
            return;
        }

        this.videoSourceBuffer.remove(0, Infinity);
        if (this.audioSourceBuffer) {
            this.audioSourceBuffer.remove(0, Infinity);
        }

        await new Promise(resolve => {
            this.videoSourceBuffer.addEventListener("updateend", resolve, { once: true });
        });

        if (mySessionId !== this.seekSessionId) return;

        this.currentVideoSegment = vidSegIndex + 1;

        if (audSegIndex !== -1) {
            this.currentAudioSegment = audSegIndex + 1;
        }

        this.feedNextVideoSegment();
        this.feedNextAudioSegment();
    }

    isSegmentBuffered(segmentNumber, type = 'video') {
        const rep = type === 'video' ? this.videoRepresentation : this.audioRepresentation;
        const sb = type === 'video' ? this.videoSourceBuffer : this.audioSourceBuffer;

        if (!sb || !rep) return false;

        const segmentInfo = rep.segments[segmentNumber - 1];

        if (!segmentInfo) return false;

        const segStart = segmentInfo.start;
        const segEnd = segmentInfo.start + segmentInfo.duration;
        const buffered = sb.buffered;
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
        try {
            const initResp = await fetch(newRepresentation.init)
            const initBuffer = await initResp.arrayBuffer();
            await this.appendBufferSafe(this.videoSourceBuffer, initBuffer);

            this.videoRepresentation = newRepresentation;
            this.ui.updateQuality(newRepresentation.height + "p");
            console.log("Switched to representation:", newRepresentation.height + "p");
        } catch (error) {
            this.ui.log(`Error switching representation: ${error.message}`);
        }
    }
}
