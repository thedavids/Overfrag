import fetch from 'node-fetch';
import { spawn } from 'child_process';
import { io } from "socket.io-client";

export function createInstancesSystem(roomsSystem) {
    const IS_LOBBY = process.env.IS_LOBBY !== "false";
    process.env.PORT = process.env.PORT || "3000";
    const PORT = parseInt(process.env.PORT, 10);
    const MAIN_INSTANCE_URL = process.env.LOBBY_URL || `http://localhost:${PORT}`;

    const MAX_ROOMS_PER_INSTANCE = process.env.MAX_ROOMS_PER_INSTANCE || 10;
    const NODE_ENV = process.env.NODE_ENV?.toLowerCase?.() || "development";
    const isLocal = NODE_ENV !== "production";
    let nextPort = PORT + 1;

    const instanceRegistry = {
        [MAIN_INSTANCE_URL]: { roomIds: new Set(), localProcess: null }
    };

    const preallocatedRemoteUrls = [
        'https://multiplayerbackend-gameinstance-01.onrender.com',
        'https://multiplayerbackend-gameinstance-02.onrender.com'
    ];

    const RENDER_API_KEY = process.env.RENDER_API_KEY;
    const RENDER_SERVICE_IDS = {
        "https://multiplayerbackend-gameinstance-01.onrender.com": "srv-d1nd5n3uibrs73ffukn0",
        "https://multiplayerbackend-gameinstance-02.onrender.com": "srv-d1nd5n3uibrs73ffukmg"
    };

    function isLobby() {
        return IS_LOBBY;
    }

    async function spawnNewInstance() {
        if (isLocal) {
            const port = nextPort++;
            return spawnLocalInstance(port);
        }
        else {
            return await spawnRemoteInstance();
        }
    }

    function spawnLocalInstance(port) {
        const child = spawn("node", ["server.js"], {
            env: { ...process.env, PORT: port, IS_LOBBY: "false", LOBBY_URL: MAIN_INSTANCE_URL },
            stdio: "inherit"
        });

        const url = `http://localhost:${port}`;
        instanceRegistry[url] = {
            roomIds: new Set(),
            localProcess: child
        };

        console.log(`Spawned local instance: ${url}`);
        return url;
    }

    async function waitForInstanceToBeReady(url, maxAttempts = 40, delay = 3000) {
        for (let i = 0; i < maxAttempts; i++) {
            try {
                console.log(`[WAIT] Attempting socket connection to ${url} (${i + 1}/${maxAttempts})...`);

                await new Promise((resolve, reject) => {
                    const socket = io(url, {
                        transports: ['websocket'],
                        timeout: delay,
                        reconnection: false
                    });

                    socket.on("connect", () => {
                        socket.disconnect();
                        resolve();
                    });

                    socket.on("connect_error", (err) => {
                        socket.disconnect();
                        reject(err);
                    });
                });

                console.log(`[WAIT] Successfully connected to ${url}`);
                return true;
            }
            catch (err) {
                console.warn(`[WAIT] Socket connection failed: ${err.message}`);
                await new Promise(res => setTimeout(res, delay));
            }
        }

        console.error(`[WAIT] Failed to connect to ${url} after ${maxAttempts} attempts.`);
        return false;
    }

    async function spawnRemoteInstance() {
        const available = preallocatedRemoteUrls.find(url => !instanceRegistry[url]);
        if (!available) throw new Error("No available remote instance.");

        const serviceId = RENDER_SERVICE_IDS[available];
        if (!serviceId) throw new Error(`Missing Render service ID for ${available}`);

        try {
            // Trigger resume
            const resumeRes = await fetch(`https://api.render.com/v1/services/${serviceId}/resume`, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${RENDER_API_KEY}`,
                    'Content-Type': 'application/json'
                }
            });

            if (!resumeRes.ok) {
                let message = resumeRes.statusText;
                try {
                    const data = await resumeRes.json();
                    message = data.message || message;

                    if (resumeRes.status === 400 /*&& message.toLowerCase().includes("already live")*/) {
                        console.log(`[RESUME] Instance already live: ${available}: ${message}`);
                    }
                    else {
                        console.warn(`[RESUME] Failed to resume Render service ${available}: ${message}`);
                        return null;
                    }
                }
                catch (err) {
                    console.warn(`[RESUME] Failed to resume Render service ${available}: Unknown error`);
                    return null;
                }
            }
            console.log(`[RESUME] Triggered resume for: ${available}`);

            // Wait for the service to actually respond over socket
            const ready = await waitForInstanceToBeReady(available);
            if (!ready) return null;

            instanceRegistry[available] = { roomIds: new Set() };
            return available;

        } catch (err) {
            console.warn(`[RESUME] Error during resume:`, err.message);
            return null;
        }
    }

    async function shutdownInstance(url) {

        console.log(`shutdownInstance start for instance: ${url}`);

        const entry = instanceRegistry[url];
        if (!entry || url === MAIN_INSTANCE_URL) return;

        if (isLocal && entry.localProcess) {
            entry.localProcess.kill();
            console.log(`Killed local instance: ${url}`);
        }
        else if (!isLocal) {
            const serviceId = RENDER_SERVICE_IDS[url];

            console.log(`shutdownInstance start for serviceId: ${serviceId}`);

            if (serviceId) {
                try {
                    const res = await fetch(`https://api.render.com/v1/services/${serviceId}/suspend`, {
                        method: 'POST',
                        headers: {
                            'Authorization': `Bearer ${RENDER_API_KEY}`,
                            'Content-Type': 'application/json'
                        }
                    });

                    if (!res.ok) {
                        console.warn(`[SHUTDOWN] Failed to suspend Render service ${url}: ${res.statusText}`);
                    }
                    else {
                        console.log(`Suspended remote instance: ${url}`);
                    }
                }
                catch (err) {
                    console.warn(`[SHUTDOWN] Error suspending remote instance ${url}:`, err.message);
                }
            }
            else {
                console.warn(`[SHUTDOWN] No Render service ID found for ${url}`);
            }
        }

        delete instanceRegistry[url];
    }

    function getRoomCount(instanceUrl) {
        return instanceRegistry[instanceUrl]?.roomIds.size || 0;
    }

    function getRoomInstanceUrl(roomId) {
        for (const url in instanceRegistry) {
            if (instanceRegistry[url].roomIds.has(roomId)) {
                return url;
            }
        }
        return null; // not found
    }

    async function allocateRoomInstance(roomId) {
        for (const url in instanceRegistry) {
            if (getRoomCount(url) < MAX_ROOMS_PER_INSTANCE) {
                instanceRegistry[url].roomIds.add(roomId);
                return url;
            }
        }

        const newInstanceUrl = await spawnNewInstance();
        if (newInstanceUrl != null) {
            instanceRegistry[newInstanceUrl].roomIds.add(roomId);
        }
        return newInstanceUrl;
    }

    function deallocateRoomInstance(roomId) {
        for (const url in instanceRegistry) {
            const entry = instanceRegistry[url];
            if (entry.roomIds.has(roomId)) {
                entry.roomIds.delete(roomId);

                if (url !== MAIN_INSTANCE_URL && entry.roomIds.size === 0) {
                    shutdownInstance(url);
                }

                break;
            }
        }
        checkShutdown();
    }

    const reportToLobby = async (path, body) => {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 3000); // 3 seconds

        try {
            console.log(`begin reportToLobby ${MAIN_INSTANCE_URL}/internal/${path}`, path);

            const res = await fetch(`${MAIN_INSTANCE_URL}/internal/${path}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
                signal: controller.signal
            });

            console.log('status', res.status);
            console.log('end reportToLobby', path);
        } catch (err) {
            console.warn(`[REPORT] Failed to report to lobby: ${err.message}`);
        } finally {
            clearTimeout(timeout);
        }
    };

    function checkShutdown() {
        const activeRoomCount = Object.keys(roomsSystem.getRooms()).length;

        if (activeRoomCount === 0 && !IS_LOBBY) {
            console.log(`[SHUTDOWN] No active rooms. Exiting instance in 3 seconds...`);
            setTimeout(() => {
                process.exit(0);
            }, 3000);
        }
    }

    return {
        isLobby,
        spawnNewInstance,
        spawnLocalInstance,
        spawnRemoteInstance,
        shutdownInstance,
        getRoomCount,
        getRoomInstanceUrl,
        allocateRoomInstance,
        deallocateRoomInstance,
        reportToLobby,
        checkShutdown
    };
}