// shared/models-dictionary.js
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

export const ModelsDictionary = (() => {
  const cache = {};
  const pending = {};
  const loader = new GLTFLoader();

  async function get(file, modelName) {
    const cacheKey = `${file}:${modelName}`;
    if (cache[cacheKey]) return cache[cacheKey].clone(true);
    if (pending[cacheKey]) return pending[cacheKey].then(c => c.clone(true));

    const promise = new Promise((resolve, reject) => {
      loader.load(
        file,
        (gltf) => {
          let found = null;
          gltf.scene.traverse(child => {
            if (child.name === modelName) {
              found = child;
            }
          });

          if (!found) {
            console.warn(`Model "${modelName}" not found in ${file}`);
            reject(new Error(`Model "${modelName}" not found in ${file}`));
            return;
          }

          const wrapper = new THREE.Group();
          wrapper.name = `Wrapped_${modelName}`;
          wrapper.add(found);

          const box = new THREE.Box3().setFromObject(wrapper);
          const center = new THREE.Vector3();
          box.getCenter(center);

          wrapper.children.forEach(child => child.position.sub(center));

          const finalBox = new THREE.Box3().setFromObject(wrapper);
          const size = new THREE.Vector3();
          finalBox.getSize(size);

          wrapper.userData.size = [size.x, size.y, size.z];
          wrapper.userData.baseSize = [size.x, size.y, size.z];
          wrapper.userData.offset = { x: center.x, y: center.y, z: center.z };
          wrapper.userData.model = modelName;
          wrapper.userData.file = file;

          cache[cacheKey] = wrapper;
          resolve(wrapper.clone(true));
        },
        undefined,
        (err) => {
          console.error(`Failed to load model from ${file}`, err);
          reject(err);
        }
      );
    });

    pending[cacheKey] = promise;
    return promise;
  }

  return { get };
})();
