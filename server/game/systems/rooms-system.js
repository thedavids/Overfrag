import { EventBus } from '../shared/event-bus.js';

export function createRoomsSystem({ mapUtils }) {
    const rooms = {};
    const playerLastSeen = {};

    function getRooms() {
        return rooms;
    }

    function hasRoom(id) {
        return !!rooms[id];
    }

    function getPlayerRoom(socketId) {
        for (const roomId in rooms) {
            if (rooms[roomId].players[socketId]) return roomId;
        }
        return null;
    }

    function generateRoomId() {
        const roomId = `room-${Math.random().toString(36).substr(2, 6)}`;
        return roomId;
    }

    function getRoomsByIdAndPlayersCount() {
        const availableRooms = Object.entries(getRooms()).map(([id, room]) => ({
            id,
            count: Object.keys(room.players).length
        }));
        return availableRooms;
    }

    async function createRoomLobby({ roomId, name, modelName }) {
        const safeName = name.trim().substring(0, 64).replace(/[^\w\s-]/g, '');
        const safeModel = modelName.trim().substring(0, 64).replace(/[^\w.-]/g, '');

        rooms[roomId] = {
            id: roomId,
            players: {},
            map: null,
            isLobby: true
        };

        EventBus.emit("roomsSystem:roomCreated", { roomId });

        return { roomId, safeName, safeModel };
    }

    async function createRoomGame({ roomId, name, modelName, mapName, allowBots }) {
        const safeName = name.trim().substring(0, 64).replace(/[^\w\s-]/g, '');
        const safeModel = modelName.trim().substring(0, 64).replace(/[^\w.-]/g, '');

        let mapNameToLoad = safeName.toLowerCase() === 'q2dm1'
            ? safeName.toLowerCase()
            : (mapName || 'default');

        let map;

        if (mapNameToLoad === 'q2dm1') {
            map = await mapUtils.prepareMap('q2dm1'); // do not cache
        } else {
            if (!mapUtils.maps[mapNameToLoad] || !mapUtils.maps[mapNameToLoad].objects) {
                mapUtils.maps[mapNameToLoad] = await mapUtils.prepareMap(mapNameToLoad);
            }
            map = mapUtils.maps[mapNameToLoad];
        }

        rooms[roomId] = {
            id: roomId,
            players: {},
            map,
            isLobby: false,
            allowBots: true
        };

        EventBus.emit("roomsSystem:roomCreated", { roomId });

        return { roomId, safeName, safeModel, map };
    }

    function addPlayer(roomId, socketId, { name, modelName, health }) {
        if (rooms[roomId] == null) {
            return;
        }
        
        rooms[roomId].players[socketId] = {
            name,
            modelName,
            position: { x: 0, y: 0, z: 0 },
            health: health,
            kill: 0,
            death: 0,
            kdratio: 0
        };

        EventBus.emit("roomsSystem:playerConnected", { roomId, socketId, name });
    }

    function removePlayer(socketId) {
        for (const roomId in rooms) {
            const room = rooms[roomId];
            if (room.players[socketId]) {
                const name = room.players[socketId].name;

                delete room.players[socketId];
                EventBus.emit("roomsSystem:playerDisconnected", { roomId, socketId, name });

                if (Object.keys(room.players).length === 0 || Object.values(room.players).every(p => p.isBot)) {
                    delete rooms[roomId];
                    EventBus.emit("roomsSystem:roomDeleted", { roomId });
                }
                break;
            }
        }

        delete playerLastSeen[socketId];
    }

    function getPlayers(roomId) {
        return rooms[roomId]?.players || {};
    }

    function setLastSeen(socketId) {
        playerLastSeen[socketId] = Date.now();
    }

    function cleanupInactivePlayers(timeout = 30000, io) {
        const now = Date.now();
        const THREE_MINUTES = 3 * 60 * 1000;

        for (const socketId in playerLastSeen) {
            if (now - playerLastSeen[socketId] > timeout) {
                const sock = io.sockets.sockets.get(socketId);
                if (sock) {
                    removePlayer(socketId); // this will now send messages too
                    sock.disconnect();
                }
            }
        }

        for (const [roomId, room] of Object.entries(rooms)) {
            const playerCount = Object.keys(room.players).length;

            if (playerCount === 0) {
                if (!room.emptySince) {
                    // Mark the timestamp when it first became empty
                    room.emptySince = now;
                }
                else if (now - room.emptySince > THREE_MINUTES) {
                    // Delete room if it's been empty too long
                    delete rooms[roomId];
                    EventBus.emit("roomsSystem:roomDeleted", { roomId });
                }
            }
            else {
                // Reset the timestamp if the room is no longer empty
                delete room.emptySince;
            }
        }
    }

    return {
        getRooms,
        getRoomsByIdAndPlayersCount,
        hasRoom,
        generateRoomId,
        getPlayerRoom,
        getPlayers,
        createRoomLobby,
        createRoomGame,
        addPlayer,
        removePlayer,
        setLastSeen,
        cleanupInactivePlayers
    };
}
