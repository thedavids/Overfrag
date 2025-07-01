export class GameState {
  constructor({ roomId = null, playerId = null, playerObj = null, octree = null, players = null, requiresPrecisePhysics = false } = {}) {
    this.roomId = roomId;
    this.playerId = playerId;
    this.playerObj = playerObj;
    this.octree = octree;
    this.players = players;
    this.requiresPrecisePhysics = requiresPrecisePhysics;
  }

  clear() {
    this.roomId = null;
    this.playerId = null;
    this.playerObj = null;
    this.octree = null;
    this.players = null;
    this.requiresPrecisePhysics = false;
  }

  isValid() {
    return !!this.playerObj;
  }
}