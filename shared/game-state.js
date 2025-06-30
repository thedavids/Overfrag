export class GameState {
  constructor({ roomId = null, playerId = null, playerObj = null, octree = null, players = null } = {}) {
    this.roomId = roomId;
    this.playerId = playerId;
    this.playerObj = playerObj;
    this.octree = octree;
    this.players = players;
  }

  clear() {
    this.roomId = null;
    this.playerId = null;
    this.playerObj = null;
    this.octree = null;
    this.players = null;
  }

  isValid() {
    return !!this.playerObj;
  }
}