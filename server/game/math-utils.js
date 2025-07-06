import * as THREE from 'three';

export function toVector3(obj) {
    return new THREE.Vector3(obj.x, obj.y, obj.z);
}

export function distanceVec3(a, b) {
    return Math.sqrt(
        (a.x - b.x) ** 2 +
        (a.y - b.y) ** 2 +
        (a.z - b.z) ** 2
    );
}

export function vec3({ x, y, z }) {
    return { x, y, z };
}

export function subtractVec3(a, b) {
    return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
}

export function addVec3(a, b) {
    return { x: a.x + b.x, y: a.y + b.y, z: a.z + b.z };
}

export function scaleVec3(a, s) {
    return { x: a.x * s, y: a.y * s, z: a.z * s };
}

export function dotVec3(a, b) {
    return a.x * b.x + a.y * b.y + a.z * b.z;
}

export function normalizeVec3(v) {
    const length = Math.sqrt(v.x ** 2 + v.y ** 2 + v.z ** 2) || 1;
    return { x: v.x / length, y: v.y / length, z: v.z / length };
}

export function segmentSphereIntersect(p1, p2, center, radius) {
    const d = subtractVec3(p2, p1); // segment direction
    const f = subtractVec3(p1, center); // from center to segment start

    const a = dotVec3(d, d);
    const b = 2 * dotVec3(f, d);
    const c = dotVec3(f, f) - radius * radius;

    const discriminant = b * b - 4 * a * c;
    if (discriminant < 0) return false;

    const t1 = (-b - Math.sqrt(discriminant)) / (2 * a);
    const t2 = (-b + Math.sqrt(discriminant)) / (2 * a);

    return (t1 >= 0 && t1 <= 1) || (t2 >= 0 && t2 <= 1);
}

export function base64ToArrayBuffer(base64) {
    const binary = atob(base64);
    const len = binary.length;
    const buffer = new ArrayBuffer(len);
    const view = new Uint8Array(buffer);
    for (let i = 0; i < len; i++) {
        view[i] = binary.charCodeAt(i);
    }
    return buffer;
}

export function rayIntersectsAABB(origin, dir, maxDist, min, max) {
    let tmin = (min.x - origin.x) / dir.x;
    let tmax = (max.x - origin.x) / dir.x;
    if (tmin > tmax) [tmin, tmax] = [tmax, tmin];

    let tymin = (min.y - origin.y) / dir.y;
    let tymax = (max.y - origin.y) / dir.y;
    if (tymin > tymax) [tymin, tymax] = [tymax, tymin];

    if ((tmin > tymax) || (tymin > tmax)) return null;
    if (tymin > tmin) tmin = tymin;
    if (tymax < tmax) tmax = tymax;

    let tzmin = (min.z - origin.z) / dir.z;
    let tzmax = (max.z - origin.z) / dir.z;
    if (tzmin > tzmax) [tzmin, tzmax] = [tzmax, tzmin];

    if ((tmin > tzmax) || (tzmin > tmax)) return null;

    const hitDist = Math.max(tmin, tzmin);
    return (hitDist >= 0 && hitDist <= maxDist) ? hitDist : null;
}
