import { parseManifest } from "./parseManifest.js";

export const baseURL = "http://localhost:8080/dash/";

const response = await fetch(baseURL + "manifest.mpd");
if (!response.ok) {
    throw new Error(`HTTP error! status: ${response.status}`);
}

const manifestText = await response.text();
const [totalDuration, adaptations] = parseManifest(manifestText, baseURL);
console.log("Adaptations:", adaptations);

const videoElement = document.getElementById("videoPlayer");
const mediaSource = new MediaSource();
videoElement.src = URL.createObjectURL(mediaSource);

let sourceBuffer;
const rep = adaptations[0]; // hardcoded to first representation for simplicity

mediaSource.addEventListener("sourceopen", async () => {
    mediaSource.duration = totalDuration;

    const mimeType = `${rep.mimeType}; codecs="${rep.codecs}"`;
    sourceBuffer = mediaSource.addSourceBuffer(mimeType);

    const initResp = await fetch(rep.init);
    const initBuffer = await initResp.arrayBuffer();
    sourceBuffer.appendBuffer(initBuffer);

    sourceBuffer.addEventListener("updateend", feedNextSegment);
});

let currentSegment = 1;

async function feedNextSegment() {
    if (currentSegment > rep.nSegments) {
        return;
    }

    const mediaTemplate = rep.mediaTemplate;
    const id = rep.id;

    console.log(`Fetching segment ${currentSegment} of ${rep.nSegments}`);
    await delay(2000); // Simulate network delay

    const mediaURL = mediaTemplate.replace("$RepresentationID$", id)
        .replace("$Number$", currentSegment)
        .replace(".m4s", ""); // Server API does not expect file extension
    const mediaResp = await fetch(mediaURL);
    const mediaBuffer = await mediaResp.arrayBuffer();
    sourceBuffer.appendBuffer(mediaBuffer);

    currentSegment += currentSegment < rep.nSegments ? 1 : 0;
}

function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

videoElement.addEventListener("ended", () => {
    if (mediaSource.readyState === "open") {
        mediaSource.endOfStream();
    }
});

// seek
videoElement.addEventListener("seeking", () => {
    console.log(`Seeking to ${videoElement.currentTime.toFixed(2)} seconds`);
    handleSeek(videoElement.currentTime);
});

async function handleSeek(seekTime) {
    const segmentIndex = rep.segments.findIndex(seg => {
        const endTime = seg.start + seg.duration;
        return seekTime >= seg.start && seekTime < endTime;
    });

    if (segmentIndex === -1) {
        console.warn("Seek time is out of range of available segments.");
        return;
    }

    // clear buffer for re-fetching
    if (sourceBuffer.updating) {
        await new Promise(resolve => {
            sourceBuffer.addEventListener("updateend", resolve, { once: true });
        });
    }
    sourceBuffer.remove(0, mediaSource.duration);
    currentSegment = segmentIndex + 1;
}
