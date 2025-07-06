import { EventBus } from '../shared/event-bus.js';

export function createHealthPacksSystem() {

    function tryPickupHealthPack(roomId, room, playerId) {
        const player = room.players[playerId];
        if (!player) return;

        for (const pack of room.map.healthPacks) {
            if (!pack.available) continue;

            const dx = player.position.x - pack.position.x;
            const dy = player.position.y - pack.position.y;
            const dz = player.position.z - pack.position.z;
            const distSq = dx * dx + dy * dy + dz * dz;

            if (distSq < 2.0) {
                pack.available = false;
                player.health = Math.min(100, (player.health || 100) + 25);

                EventBus.emit("healthPacksSystem:healthPackTaken", { roomId, id: pack.id, targetPlayerId: playerId, health: player.health });

                setTimeout(() => {
                    pack.available = true;
                    EventBus.emit("healthPacksSystem:healthPackRespawned", { roomId, id: pack.id });
                }, 10000);
            }
        }
    }

    return {
        tryPickupHealthPack
    };
}
