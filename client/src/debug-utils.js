const urlParams = new URLSearchParams(window.location.search);
window.debug = urlParams.get('debug') === 'true';
if (window.debug) {
    console.warn("[DEBUG] Activated.");
}
export function OctreeClearDebugWires(scene, debugId) {
    if (window.debug !== true) {
        return;
    }
    for (let i = scene.children.length - 1; i >= 0; i--) {
        const obj = scene.children[i];
        if (obj.userData?.debugId != null && obj.userData?.debugId === debugId) {
            scene.remove(obj);
        }
    }
}

export function OctreeDrawQueriedObjects(objects, scene, debugId, color = 0x00ff00) {
    if (window.debug !== true) {
        return;
    }
    OctreeClearDebugWires(scene, debugId);

    for (const obj of objects) {
        const box = obj.userData?.box;
        if (!box) continue;

        const size = {
            x: box.max.x - box.min.x,
            y: box.max.y - box.min.y,
            z: box.max.z - box.min.z
        };
        const center = {
            x: (box.min.x + box.max.x) / 2,
            y: (box.min.y + box.max.y) / 2,
            z: (box.min.z + box.max.z) / 2
        };

        const geometry = new THREE.BoxGeometry(size.x, size.y, size.z);
        const edges = new THREE.EdgesGeometry(geometry);
        const wire = new THREE.LineSegments(
            edges,
            new THREE.LineBasicMaterial({ color })
        );
        wire.position.set(center.x, center.y, center.z);
        wire.userData.debugId = debugId; // tag for cleanup
        scene.add(wire);
    }
}

export function OctreeDrawAABB(node, scene, debugId) {
    if (window.debug !== true) {
        return;
    }

    // Draw node boundary in white
    const boxSize = node.size;
    const half = boxSize / 2;
    const geometry = new THREE.BoxGeometry(boxSize, boxSize, boxSize);
    const edges = new THREE.EdgesGeometry(geometry);
    const line = new THREE.LineSegments(
        edges,
        new THREE.LineBasicMaterial({ color: 0xffffff })
    );
    line.position.set(node.center.x, node.center.y, node.center.z);
    line.userData.debugId = debugId;
    scene.add(line);

    // Draw red AABBs for each object in this node
    for (const obj of node.objects) {
        const size = obj.size;
        const center = obj.center;

        // Draw box using size + center (world-aligned)
        const geom = new THREE.BoxGeometry(size[0], size[1], size[2]);
        const edge = new THREE.EdgesGeometry(geom);
        const line = new THREE.LineSegments(edge, new THREE.LineBasicMaterial({ color: 0xff0000 }));
        line.position.copy(center);
        scene.add(line);
    }

    // Recurse into children
    if (node.children) {
        for (const child of node.children) {
            OctreeDrawAABB(child, scene, debugId);
        }
    }
}