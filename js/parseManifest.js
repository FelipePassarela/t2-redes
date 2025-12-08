export function parseManifest(manifest, baseURL) {
    const parser = new DOMParser();
    const xmlDoc = parser.parseFromString(manifest, "application/xml");

    const mpdNode = xmlDoc.getElementsByTagName("MPD")[0];
    const durationStr = mpdNode.getAttribute("mediaPresentationDuration");
    const totalDuration = parseDuration(durationStr);

    const periods = xmlDoc.getElementsByTagName("Period");
    const adaptations = [];

    for (let period of periods) {
        const adaptationSets = period.getElementsByTagName("AdaptationSet");

        for (let adaptationSet of adaptationSets) {
            const representations = adaptationSet.getElementsByTagName("Representation");
            for (let representation of representations) {
                let id = representation.getAttribute("id");

                const segmentTemplate = representation.getElementsByTagName("SegmentTemplate")[0];
                let init = segmentTemplate.getAttribute("initialization");
                init = init.replace("$RepresentationID$", id);

                const segmentTimeline = segmentTemplate.getElementsByTagName("SegmentTimeline")[0];
                const media = segmentTemplate.getAttribute("media");
                let nSegments = segmentTimeline.getElementsByTagName("S").length;

                const timeScale = parseInt(segmentTemplate.getAttribute("timescale"));
                let accumulatedTime = 0;
                const segments = [];
                
                for (let segment of segmentTimeline.getElementsByTagName("S")) {
                    let duration = parseInt(segment.getAttribute("d"));
                    let durationSec = duration / timeScale;
                    segments.push({
                        start: accumulatedTime,
                        duration: durationSec
                    });
                    accumulatedTime += durationSec;
                }

                adaptations.push({
                    id: id,
                    bandwidth: representation.getAttribute("bandwidth"),
                    mimeType: representation.getAttribute("mimeType"),
                    codecs: representation.getAttribute("codecs"),
                    init: baseURL + init,
                    mediaTemplate: baseURL + media,
                    nSegments: nSegments,
                    segments: segments
                });
            }
        }
    }

    return [totalDuration, adaptations];
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
