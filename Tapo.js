/*
 * Tapo plugin for SignalRGB
 *
 * Original plugin: SyedAhkam
 * https://github.com/sedbytes/signalrgb-tapo
 * API-key authentication, colour smoothing and fixes: DukeShank
 * https://github.com/DukeShank/signalrgb-tapo
 *
 * PURPOSE
 * Sends one colour per device, averaged from the SignalRGB canvas, to
 * TP-Link Tapo lights and plugs through a local tapo-rest server.
 *
 * TARGET HARDWARE (device types as listed by tapo-rest)
 * - Colour: L530, L535, L630 bulbs; L900, L920, L930 light strips
 * - Brightness only: L510, L520, L610 bulbs
 * - On/off only: P100, P105, P110, P110M, P115 plugs and other types
 * - Not added: P300, P304, P304M, P316 power strips (tapo-rest has no
 *   on/off route for them)
 *
 * PROTOCOL
 * - tapo-rest 0.5 HTTP API: https://github.com/ClementNerma/tapo-rest
 * - Every request carries "Authorization: Bearer <API key>", a key from
 *   the server.api_keys list of the tapo-rest configuration
 * - GET /devices lists the devices of the tapo-rest configuration
 * - GET /actions/<type>/<action>?device=<name>&<parameters>
 *     set-hue-saturation  hue 0-360, saturation 1-100
 *     set-brightness      level 1-100
 *     set-color-temperature  color_temperature 2500-6500 (K)
 *     on, off
 *   set-hue-saturation and set-brightness also turn a light on.
 *
 * SETTINGS
 * - Service panel: tapo-rest host, port and API key; Frame Skip and
 *   Min Delta (send rate and change threshold)
 * - Device page: Lighting Mode, Forced Color, Brightness (%),
 *   On Exit or Sleep
 *
 * EXIT AND SLEEP
 * Shutdown() sends one request, chosen by "On Exit or Sleep":
 * - Warm white: colour lights change to 3000 K at their current
 *   brightness; other devices turn off. On sleep every device turns off.
 * - Turn off: every device turns off.
 * - Leave as is: nothing is sent.
 *
 * INSTALLATION
 * Add this repository as an add-on in SignalRGB (branch: master).
 *
 * LIMITATIONS
 * - One colour per device. Strips are not addressed per segment:
 *   tapo-rest has no per-segment colour route.
 * - Every change takes one or two HTTP requests through tapo-rest to the
 *   device, so a device follows the canvas a few times per second.
 * - The API key is stored in SignalRGB's plugin settings as plain text.
 *
 * STATUS
 * Version 3.1.0, not yet tested on hardware. It has been checked only
 * with host tests (Node, mocked SignalRGB objects, a fake tapo-rest).
 * See README.md.
 *
 * LICENCE
 * MIT. See the repository's LICENSE file.
 */

/* global
controller:readonly, service:readonly, device:readonly, XMLHttpRequest:readonly,
LightingMode:readonly, forcedColor:readonly, brightnessScale:readonly,
shutdownMode:readonly
*/

// The settings above are globals that SignalRGB sets from
// ControllableParameters(). They are not declared in this file: a
// module-level declaration would hide the values SignalRGB sets. Each read
// checks for "undefined" and falls back to the default.

export function Name() { return "Tapo"; }
export function Version() { return "3.1.0"; }
export function Type() { return "network"; }
export function DeviceType() { return "lightingcontroller"; }
export function Publisher() { return "SyedAhkam, DukeShank"; }
export function SubdeviceController() { return false; }
export function Size() { return [1, 1]; }
export function DefaultPosition() { return [0, 0]; }
export function DefaultScale() { return 10.0; }

// Image hosted in this repository. Used for the device image and for the
// icon of the service tile on SignalRGB's Third Party Services page.
// Requirements: 1024x1024 transparent PNG, artwork inside the central
// 920x920 area, reachable at a public URL.
const TAPO_IMAGE_URL =
    "https://raw.githubusercontent.com/DukeShank/signalrgb-tapo/master/images/tapo-signalrgb.png";

export function ImageUrl() {
    return TAPO_IMAGE_URL;
}

export function ControllableParameters() {
    return [
        {
            property: "LightingMode",
            group: "lighting",
            label: "Lighting Mode",
            type: "combobox",
            values: ["Canvas", "Forced"],
            default: "Canvas"
        },
        {
            property: "forcedColor",
            group: "lighting",
            label: "Forced Color",
            min: "0",
            max: "360",
            type: "color",
            default: "#0099ff"
        },
        {
            property: "brightnessScale",
            group: "lighting",
            label: "Brightness (%)",
            type: "number",
            min: "1",
            max: "100",
            step: "1",
            default: "100"
        },
        {
            property: "shutdownMode",
            group: "lighting",
            label: "On Exit or Sleep",
            type: "combobox",
            values: ["Leave as is", "Turn off", "Warm white"],
            default: "Warm white"
        }
    ];
}

// ============================================================
// CONFIGURATION
// ============================================================

const TAPO_DEFAULT_HOST = "127.0.0.1";
const TAPO_DEFAULT_PORT = 8000;

// Frame Skip: Render() calls between sends. SignalRGB calls Render()
// about every 30 ms, so 6 gives at most about 5 updates per second.
const TAPO_DEFAULT_FRAME_SKIP = 6;
const TAPO_MAX_FRAME_SKIP = 30;

// Min Delta: smallest change (hue in degrees, saturation and brightness
// in percent) that is sent. 0 sends every update. Changes between on and
// off are always sent.
const TAPO_DEFAULT_MIN_DELTA = 3;

// Fraction of the remaining colour difference applied per update.
// Lower values produce slower, smoother transitions.
const TAPO_SMOOTHING_FACTOR = 0.30;

// A request without an answer after this time is abandoned.
const TAPO_REQUEST_TIMEOUT_MS = 5000;

// Pause before the next device request after a failed one.
const TAPO_RETRY_MS = 2000;

// Interval between /devices attempts while tapo-rest cannot be reached.
const TAPO_DISCOVERY_RETRY_MS = 10000;

// Colour temperature used by "On Exit or Sleep: Warm white".
const TAPO_WARM_WHITE_K = 3000;

// Light strips are sampled at this many points along one row of the
// canvas and the colours are averaged. Bulbs and plugs use one point.
const TAPO_STRIP_SAMPLE_POINTS = 20;

const TAPO_DEFAULT_FORCED_COLOR = "#0099ff";

// ============================================================
// HELPERS
// ============================================================

// Returns what a tapo-rest device type supports.
// color: set-hue-saturation, dim: set-brightness,
// supported: false for types without on/off routes in tapo-rest.
function tapoDeviceCaps(type) {
    const t = String(type || "").toLowerCase();

    if (/^l9(00|20|30)/.test(t)) {
        return { kind: "light strip", color: true, dim: true, supported: true };
    }

    if (/^l(530|535|630)/.test(t)) {
        return { kind: "colour bulb", color: true, dim: true, supported: true };
    }

    if (/^l(510|520|610)/.test(t)) {
        return { kind: "dimmable bulb", color: false, dim: true, supported: true };
    }

    if (/^p3\d\d/.test(t)) {
        return { kind: "power strip", color: false, dim: false, supported: false };
    }

    return { kind: "on/off device", color: false, dim: false, supported: true };
}

// Integer in [min, max], or the fallback for missing or invalid values.
function tapoParseInt(value, min, max, fallback) {
    const n = parseInt(value, 10);

    return Number.isFinite(n) && n >= min && n <= max ? n : fallback;
}

function tapoText(value) {
    return value === undefined || value === null ? "" : String(value).trim();
}

// Host name or IP address without "http://" or a path.
function tapoCleanHost(value) {
    return tapoText(value).replace(/^https?:\/\//i, "").replace(/\/.*$/, "");
}

function tapoDescribeHttpError(status, body, server) {
    const text = tapoText(body).slice(0, 200);

    if (status === 0) {
        return "tapo-rest not reachable at " + server;
    }

    if (status === 403) {
        return "API key rejected by tapo-rest (HTTP 403)";
    }

    return "HTTP " + status + (text ? ": " + text : "");
}

// ============================================================
// DISCOVERY SERVICE
// ============================================================

export function DiscoveryService() {
    const disc = this;

    this.IconUrl = TAPO_IMAGE_URL;

    // Read by Tapo.qml.
    this.host = TAPO_DEFAULT_HOST;
    this.port = TAPO_DEFAULT_PORT;
    this.apiKey = "";
    this.frameSkip = TAPO_DEFAULT_FRAME_SKIP;
    this.minDelta = TAPO_DEFAULT_MIN_DELTA;
    this.status = "Starting";

    let fetchId = 0;
    let fetchPending = false;
    let fetchStartedAt = 0;
    let nextFetchAt = 0;
    let devicesLoaded = false;

    function serverText() {
        return disc.host + ":" + disc.port;
    }

    // The panel shows the status; the log gets one line per change.
    function setStatus(text) {
        if (disc.status !== text) {
            disc.status = text;
            service.log("[Tapo] " + text);
        }
    }

    // Called once when SignalRGB loads the plugin.
    this.Initialize = function () {
        // The API key is stored under the setting name "password" so a key
        // saved by an earlier version is kept.
        disc.host = tapoCleanHost(service.getSetting("tapoRest", "host")) || TAPO_DEFAULT_HOST;
        disc.port = tapoParseInt(service.getSetting("tapoRest", "port"), 1, 65535, TAPO_DEFAULT_PORT);
        disc.apiKey = tapoText(service.getSetting("tapoRest", "password"));
        disc.frameSkip = tapoParseInt(
            service.getSetting("tapoRender", "frameSkip"), 1, TAPO_MAX_FRAME_SKIP, TAPO_DEFAULT_FRAME_SKIP
        );
        disc.minDelta = tapoParseInt(
            service.getSetting("tapoRender", "minDelta"), 0, 100, TAPO_DEFAULT_MIN_DELTA
        );

        service.log(
            "[Tapo] Settings loaded: tapo-rest " + serverText() +
            ", API key " + (disc.apiKey ? "set" : "not set") +
            ", Frame Skip " + disc.frameSkip +
            ", Min Delta " + disc.minDelta + "."
        );

        requestDevices(false);
    };

    // Called periodically by SignalRGB.
    this.Update = function () {
        const now = Date.now();

        if (fetchPending && now - fetchStartedAt > TAPO_REQUEST_TIMEOUT_MS) {
            fetchId++; // a late answer to the abandoned request is ignored
            fetchPending = false;
            nextFetchAt = now + TAPO_DISCOVERY_RETRY_MS;
            setStatus("No answer from tapo-rest at " + serverText() + " (retrying every 10 s)");
        }

        if (!devicesLoaded && !fetchPending && disc.apiKey && now >= nextFetchAt) {
            requestDevices(true);
        }

        for (const cont of service.controllers) {
            const bridge = cont.obj;

            if (!bridge.announced) {
                bridge.announced = true;
                service.announceController(bridge);
            }
        }
    };

    this.Discovered = function (value) {
        if (service.getController(value.id) === undefined) {
            service.addController(new TapoBridge(value));
        }
    };

    // Called from Tapo.qml: saves the connection settings, removes the
    // devices and loads the device list again.
    this.setServerConfig = function (newHost, newPort, newApiKey) {
        disc.host = tapoCleanHost(newHost) || disc.host;
        disc.port = tapoParseInt(newPort, 1, 65535, disc.port);

        const key = tapoText(newApiKey);

        if (key) {
            disc.apiKey = key;
        }

        service.saveSetting("tapoRest", "host", disc.host);
        service.saveSetting("tapoRest", "port", String(disc.port));
        service.saveSetting("tapoRest", "password", disc.apiKey);

        // Copy first: removing entries while iterating the live list can
        // skip entries.
        for (const cont of Array.from(service.controllers)) {
            service.removeController(cont);
        }

        fetchId++;
        fetchPending = false;
        devicesLoaded = false;
        nextFetchAt = 0;
        requestDevices(false);
    };

    // Called from Tapo.qml: saves the render settings and passes them to
    // the existing devices.
    this.setRenderConfig = function (newFrameSkip, newMinDelta) {
        disc.frameSkip = tapoParseInt(newFrameSkip, 1, TAPO_MAX_FRAME_SKIP, disc.frameSkip);
        disc.minDelta = tapoParseInt(newMinDelta, 0, 100, disc.minDelta);

        service.saveSetting("tapoRender", "frameSkip", String(disc.frameSkip));
        service.saveSetting("tapoRender", "minDelta", String(disc.minDelta));

        for (const cont of service.controllers) {
            cont.obj.frameSkip = disc.frameSkip;
            cont.obj.minDelta = disc.minDelta;
        }
    };

    // isRetry: true for the automatic retries, which keep the current
    // status text instead of switching to "Connecting".
    function requestDevices(isRetry) {
        if (!disc.apiKey) {
            setStatus("Not configured: enter the tapo-rest API key and press Apply");
            return;
        }

        const id = ++fetchId;

        fetchPending = true;
        fetchStartedAt = Date.now();

        if (!isRetry) {
            setStatus("Connecting to tapo-rest at " + serverText());
        }

        const xhr = new XMLHttpRequest();

        xhr.open("GET", "http://" + disc.host + ":" + disc.port + "/devices", true);
        xhr.setRequestHeader("Authorization", "Bearer " + disc.apiKey);
        xhr.onreadystatechange = function () {
            if (xhr.readyState !== 4 || id !== fetchId) {
                return;
            }

            fetchPending = false;

            if (xhr.status === 200) {
                addDevices(xhr.responseText);
                return;
            }

            // Retry only while tapo-rest is not reachable or fails. A rejected
            // key or a wrong address needs Apply with corrected settings.
            const retry = xhr.status === 0 || xhr.status >= 500;

            nextFetchAt = retry ? Date.now() + TAPO_DISCOVERY_RETRY_MS : Infinity;
            setStatus(
                tapoDescribeHttpError(xhr.status, xhr.responseText, serverText()) +
                (retry ? " (retrying every 10 s)" : "")
            );
        };
        xhr.send();
    }

    function addDevices(responseText) {
        let list = null;

        try {
            list = JSON.parse(responseText);
        } catch (e) {
            list = null;
        }

        if (!Array.isArray(list)) {
            nextFetchAt = Infinity;
            setStatus("Unexpected answer from " + serverText() + "/devices (not a device list)");
            return;
        }

        let added = 0;
        let skipped = 0;

        for (const dev of list) {
            const type = tapoText(dev && dev.device_type).toLowerCase();
            const name = tapoText(dev && dev.name);

            if (!type || !name) {
                skipped++;
                continue;
            }

            const caps = tapoDeviceCaps(type);

            if (!caps.supported) {
                skipped++;
                service.log(
                    "[Tapo] Not added: " + type.toUpperCase() + " \"" + name + "\" (" +
                    caps.kind + "; tapo-rest has no on/off route for it)"
                );
                continue;
            }

            service.log("[Tapo] Found " + type.toUpperCase() + " \"" + name + "\" (" + caps.kind + ")");

            disc.Discovered({
                id: disc.host + ":" + disc.port + "/" + name,
                name: "Tapo " + type.toUpperCase() + " – " + name,
                ip: disc.host,
                port: disc.port,
                apiKey: disc.apiKey,
                deviceName: name,
                deviceType: type,
                frameSkip: disc.frameSkip,
                minDelta: disc.minDelta
            });
            added++;
        }

        devicesLoaded = true;

        if (list.length === 0) {
            setStatus("Connected: no devices in the tapo-rest configuration");
        } else {
            setStatus(
                "Connected: " + added + (added === 1 ? " device" : " devices") + " added" +
                (skipped ? ", " + skipped + " not supported" : "")
            );
        }
    }
}

// Per-device connection data. Passed to the device instance as
// `controller` and read by Tapo.qml.
class TapoBridge {
    constructor(value) {
        this.id = value.id;
        this.name = value.name;
        this.ip = value.ip;
        this.port = value.port;
        this.apiKey = value.apiKey;
        this.deviceName = value.deviceName;
        this.deviceType = value.deviceType;
        this.frameSkip = value.frameSkip;
        this.minDelta = value.minDelta;
        this.announced = false; // set by Update() before announcing
    }
}

// ============================================================
// DEVICE STATE
// ============================================================

let tapoCaps = null;
let tapoLedCount = 1;
let tapoFrameCounter = 0;

let tapoRequestId = 0;
let tapoRequestPending = false;
let tapoRequestStartedAt = 0;
let tapoRetryAt = 0;
let tapoLastError = "";

// Last values the device confirmed. -1 / null: unknown, send again.
let tapoLastHue = -1;
let tapoLastSat = -1;
let tapoLastBri = -1;
let tapoLastOn = null;

// Colour transition smoothing.
let smoothedHue = null;
let smoothedSat = null;
let smoothedBri = null;

function tapoResetState() {
    tapoFrameCounter = 0;
    tapoRetryAt = 0;
    tapoLastHue = -1;
    tapoLastSat = -1;
    tapoLastBri = -1;
    tapoLastOn = null;
    smoothedHue = null;
    smoothedSat = null;
    smoothedBri = null;
}

// ============================================================
// LIFECYCLE
// ============================================================

export function Initialize() {
    tapoCaps = tapoDeviceCaps(controller.deviceType);
    tapoLedCount = tapoCaps.kind === "light strip" ? TAPO_STRIP_SAMPLE_POINTS : 1;

    const names = [];
    const positions = [];

    for (let i = 0; i < tapoLedCount; i++) {
        names.push("LED " + (i + 1));
        positions.push([i, 0]);
    }

    device.setName(controller.name);
    device.setSize([tapoLedCount, 1]);
    device.setControllableLeds(names, positions);

    tapoRequestPending = false;
    tapoResetState();

    device.log(
        "[Tapo] " + controller.deviceName + ": " + String(controller.deviceType).toUpperCase() +
        " (" + tapoCaps.kind + "), " + tapoLedCount +
        (tapoLedCount === 1 ? " sample point" : " sample points") +
        ", tapo-rest " + controller.ip + ":" + controller.port
    );
}

export function Render() {
    const now = Date.now();

    if (tapoRequestPending) {
        if (now - tapoRequestStartedAt < TAPO_REQUEST_TIMEOUT_MS) {
            return;
        }

        tapoRequestId++; // a late answer to the abandoned request is ignored
        tapoRequestPending = false;
        tapoRetryAt = now + TAPO_RETRY_MS;
        tapoReportError("no answer from tapo-rest within 5 s");
    }

    if (now < tapoRetryAt) {
        return;
    }

    tapoFrameCounter++;

    if (tapoFrameCounter < tapoParseInt(controller.frameSkip, 1, TAPO_MAX_FRAME_SKIP, TAPO_DEFAULT_FRAME_SKIP)) {
        return;
    }

    tapoFrameCounter = 0;

    const mode = typeof LightingMode === "undefined" ? "Canvas" : LightingMode;
    const rgb = mode === "Forced"
        ? tapoHexToRgb(typeof forcedColor === "undefined" ? TAPO_DEFAULT_FORCED_COLOR : forcedColor)
        : tapoAverageCanvas();

    if (!rgb) {
        return;
    }

    const scale = tapoParseInt(
        typeof brightnessScale === "undefined" ? 100 : brightnessScale, 1, 100, 100
    );
    const [targetHueRaw, targetSat, targetV] = tapoRgbToHsv(rgb[0], rgb[1], rgb[2]);
    const targetHue = targetHueRaw % 360;
    const targetBri = Math.round(targetV * scale / 100);

    // Start at the first target colour.
    if (smoothedHue === null) {
        smoothedHue = targetHue;
        smoothedSat = targetSat;
        smoothedBri = targetBri;
    } else {
        // Follow the shortest route around the hue wheel.
        const hueDifference = ((targetHue - smoothedHue + 540) % 360) - 180;

        smoothedHue = (smoothedHue + hueDifference * TAPO_SMOOTHING_FACTOR + 360) % 360;
        smoothedSat += (targetSat - smoothedSat) * TAPO_SMOOTHING_FACTOR;
        smoothedBri += (targetBri - smoothedBri) * TAPO_SMOOTHING_FACTOR;
    }

    // tapo-rest accepts saturation 1-100 only: white and grey (saturation
    // 0) are sent as saturation 1.
    const hue = Math.round(smoothedHue) % 360;
    const sat = Math.min(100, Math.max(1, Math.round(smoothedSat)));
    const bri = Math.min(100, Math.max(0, Math.round(smoothedBri)));

    tapoUpdateDevice(hue, sat, bri);
}

export function Shutdown(SystemSuspending) {
    if (!tapoCaps || !controller.apiKey) {
        return;
    }

    const mode = typeof shutdownMode === "undefined" ? "Warm white" : shutdownMode;

    if (mode === "Turn off" || (mode === "Warm white" && (SystemSuspending || !tapoCaps.color))) {
        tapoSend("off", "", null);
        device.log("[Tapo] " + controller.deviceName + ": shutdown, sent off.");
    } else if (mode === "Warm white") {
        tapoSend("set-color-temperature", "&color_temperature=" + TAPO_WARM_WHITE_K, null);
        device.log("[Tapo] " + controller.deviceName + ": shutdown, sent warm white (" + TAPO_WARM_WHITE_K + " K).");
    }

    tapoResetState();
}

// ============================================================
// DEVICE COMMANDS
// ============================================================

// Sends only what changed. On/off changes are always sent; brightness,
// hue and saturation only when they differ from the last confirmed value
// by at least Min Delta.
function tapoUpdateDevice(hue, sat, bri) {
    if (bri === 0) {
        if (tapoLastOn !== false) {
            tapoSend("off", "", () => {
                tapoLastOn = false;
                tapoLastBri = 0;
            });
        }

        return;
    }

    // Plugs and other on/off devices.
    if (!tapoCaps.dim) {
        if (tapoLastOn !== true) {
            tapoSend("on", "", () => {
                tapoLastOn = true;
            });
        }

        return;
    }

    const minDelta = tapoParseInt(controller.minDelta, 0, 100, TAPO_DEFAULT_MIN_DELTA);

    // set-brightness turns the light on, so it is always sent when the
    // light is off or its state is unknown.
    const sendBri = tapoLastOn !== true || tapoLastBri < 0 || Math.abs(bri - tapoLastBri) >= minDelta;

    let sendColour = false;

    if (tapoCaps.color) {
        // Compare with the last confirmed hue, accounting for wraparound.
        const hueDelta = tapoLastHue < 0
            ? Infinity
            : Math.abs(((hue - tapoLastHue + 540) % 360) - 180);

        sendColour = hueDelta >= minDelta || Math.abs(sat - tapoLastSat) >= minDelta;
    }

    const sendBrightness = () => {
        tapoSend("set-brightness", "&level=" + bri, () => {
            tapoLastBri = bri;
            tapoLastOn = true;
        });
    };

    if (sendColour) {
        tapoSend("set-hue-saturation", "&hue=" + hue + "&saturation=" + sat, () => {
            tapoLastHue = hue;
            tapoLastSat = sat;

            if (sendBri) {
                sendBrightness();
            }
        });
    } else if (sendBri) {
        sendBrightness();
    }
}

// One GET request to a tapo-rest action route. onSuccess runs after an
// HTTP 200 answer. Any other answer stops the update, is logged once and
// pauses device requests for TAPO_RETRY_MS.
function tapoSend(action, params, onSuccess) {
    const server = controller.ip + ":" + controller.port;
    const url = "http://" + server + "/actions/" + controller.deviceType + "/" + action +
        "?device=" + encodeURIComponent(controller.deviceName) + params;
    const id = ++tapoRequestId;
    const xhr = new XMLHttpRequest();

    tapoRequestPending = true;
    tapoRequestStartedAt = Date.now();

    xhr.open("GET", url, true);
    xhr.setRequestHeader("Authorization", "Bearer " + controller.apiKey);
    xhr.onreadystatechange = function () {
        if (xhr.readyState !== 4 || id !== tapoRequestId) {
            return;
        }

        tapoRequestPending = false;

        if (xhr.status === 200) {
            tapoReportOk();

            if (onSuccess) {
                onSuccess();
            }

            return;
        }

        tapoRetryAt = Date.now() + TAPO_RETRY_MS;
        tapoReportError(action + " failed: " + tapoDescribeHttpError(xhr.status, xhr.responseText, server));
    };
    xhr.send();
}

// Logs an error once; repeats of the same error are not logged.
function tapoReportError(text) {
    if (text !== tapoLastError) {
        tapoLastError = text;
        device.log("[Tapo] " + controller.deviceName + ": " + text);
    }
}

function tapoReportOk() {
    if (tapoLastError) {
        tapoLastError = "";
        device.log("[Tapo] " + controller.deviceName + ": requests succeed again.");
    }
}

// ============================================================
// COLOUR HELPERS
// ============================================================

// Average of the sample points: one for bulbs and plugs, a row for strips.
function tapoAverageCanvas() {
    let r = 0;
    let g = 0;
    let b = 0;

    for (let x = 0; x < tapoLedCount; x++) {
        const c = device.color(x, 0);

        if (!c || c.length < 3) {
            return null;
        }

        r += c[0];
        g += c[1];
        b += c[2];
    }

    return [
        Math.round(r / tapoLedCount),
        Math.round(g / tapoLedCount),
        Math.round(b / tapoLedCount)
    ];
}

// RGB (0-255) -> [H 0-360, S 0-100, V 0-100]
function tapoRgbToHsv(r, g, b) {
    r /= 255;
    g /= 255;
    b /= 255;

    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const diff = max - min;

    let h = 0;

    if (diff !== 0) {
        if (max === r) {
            h = 60 * (((g - b) / diff) % 6);
        } else if (max === g) {
            h = 60 * (((b - r) / diff) + 2);
        } else {
            h = 60 * (((r - g) / diff) + 4);
        }
    }

    if (h < 0) {
        h += 360;
    }

    const s = max === 0 ? 0 : (diff / max) * 100;
    const v = max * 100;

    return [Math.round(h), Math.round(s), Math.round(v)];
}

// "#rrggbb" or "rrggbb" -> [r, g, b], or null if the text is not a colour.
function tapoHexToRgb(hex) {
    const text = tapoText(hex).replace("#", "");

    if (!/^[0-9a-fA-F]{6}$/.test(text)) {
        return null;
    }

    const n = parseInt(text, 16);

    return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
}
