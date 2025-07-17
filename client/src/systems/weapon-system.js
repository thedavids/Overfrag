import { EventBus } from 'shared';

export function createWeaponSystem({ laser, machinegun, shotgun, rocket, railgun }) {
    const weapons = {
        laser,
        machinegun,
        shotgun,
        rocket,
        railgun
    };

    let fireHeld = false;
    let currentWeapon = 'laser';

    EventBus.on("input:shootBegin", () => {
        shoot();
        fireHeld = true;
    });

    EventBus.on("input:shootEnd", () => {
        fireHeld = false;
    });

    EventBus.on("input:switchWeapon", ({ weaponId }) => {
        if (weaponId === 2) {
            switchWeapon('shotgun');
        }
        else if (weaponId === 3) {
            switchWeapon('machinegun');
        }
        else if (weaponId === 4) {
            switchWeapon('rocket');
        }
        else if (weaponId === 5) {
            switchWeapon('railgun');
        } 
        else {
            switchWeapon('laser');
        }
    });

    EventBus.on("input:nextWeapon", () => {
        if (currentWeapon === 'laser') {
            switchWeapon('shotgun');
        } else if (currentWeapon === 'shotgun') {
            switchWeapon('machinegun');
        } else if (currentWeapon === 'machinegun') {
            switchWeapon('rocket');
        } else if (currentWeapon === 'rocket') {
            switchWeapon('railgun');
        } else {
            switchWeapon('laser');
        }
    });

    function shoot() {
        if (weapons[currentWeapon]) {
            weapons[currentWeapon].shoot();
        }
    }

    function switchWeapon(name) {
        if (weapons[name]) {
            currentWeapon = name;
            EventBus.emit("weapon:switched", { weapon: name });
        }
    }

    function getWeapon() {
        return currentWeapon;
    }

    function handleHit({ shooterId, targetId, position, health, damage }) {
        EventBus.emit("player:healthChanged", { playerId: targetId, health });
        EventBus.emit("player:tookDamage", { position, health, damage });
    }

    function update() {
        if (fireHeld) {
            shoot();
        }
    }

    return {
        shoot,
        switchWeapon,
        getWeapon,
        handleHit,
        update
    };
}
