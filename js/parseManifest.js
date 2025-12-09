export function parseManifest(manifest, baseURL) {
    const parser = new DOMParser();
    const xmlDoc = parser.parseFromString(manifest, "application/xml");

    const mpdNode = xmlDoc.getElementsByTagName("MPD")[0];
    const durationStr = mpdNode.getAttribute("mediaPresentationDuration");
    const totalDuration = parseDuration(durationStr);

    const periods = xmlDoc.getElementsByTagName("Period");
    const videoAdaptations = [];
    const audioAdaptations = [];

    for (let period of periods) {
        const adaptationSets = period.getElementsByTagName("AdaptationSet");

        for (let adaptationSet of adaptationSets) {
            const contentType = adaptationSet.getAttribute("contentType");
            const representations = adaptationSet.getElementsByTagName("Representation");

            for (let representation of representations) {
                let id = representation.getAttribute("id");

                const mimeType = representation.getAttribute("mimeType");
                const isAudio = mimeType.startsWith("audio") || contentType === "audio";
                const isVideo = mimeType.startsWith("video") || contentType === "video";

                if (!isAudio && !isVideo) continue;

                const segmentTemplate = representation.getElementsByTagName("SegmentTemplate")[0];
                let init = segmentTemplate.getAttribute("initialization");
                init = init.replace("$RepresentationID$", id);

                const segmentTimeline = segmentTemplate.getElementsByTagName("SegmentTimeline")[0];
                const media = segmentTemplate.getAttribute("media");

                const timeScale = parseInt(segmentTemplate.getAttribute("timescale"));
                let accumulatedTime = 0;
                const segments = [];

                for (let segment of segmentTimeline.getElementsByTagName("S")) {
                    let duration = parseInt(segment.getAttribute("d"));
                    let repeat = parseInt(segment.getAttribute("r")) || 0;
                    let durationSec = duration / timeScale;

                    // Add the first one
                    segments.push({
                        start: accumulatedTime,
                        duration: durationSec
                    });
                    accumulatedTime += durationSec;

                    // Add repeats
                    for (let i = 0; i < repeat; i++) {
                        segments.push({
                            start: accumulatedTime,
                            duration: durationSec
                        });
                        accumulatedTime += durationSec;
                    }
                }

                const adaptation = {
                    id: id,
                    bandwidth: representation.getAttribute("bandwidth"),
                    height: representation.getAttribute("height"),
                    mimeType: mimeType,
                    codecs: representation.getAttribute("codecs"),
                    init: baseURL + init,
                    mediaTemplate: baseURL + media,
                    nSegments: segments.length,
                    segments: segments
                };

                if (isAudio) {
                    audioAdaptations.push(adaptation);
                } else {
                    videoAdaptations.push(adaptation);
                }
            }
        }
    }

    return [totalDuration, videoAdaptations, audioAdaptations];
}

function parseDuration(str) {
    // Example string: PT29.6S
    const match = str.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?/);
    if (!match) return 0;
    const hours = parseFloat(match[1]) || 0;
    const minutes = parseFloat(match[2]) || 0;
    const seconds = parseFloat(match[3]) || 0;
    return hours * 3600 + minutes * 60 + seconds;
}
