// shared/textures-dictionary.js
import * as THREE from 'three';

export const TexturesDictionary = (() => {
  const cache = {};
  const pending = {};

  async function get(name, path, options = {}) {
    if (cache[name]) return cache[name];
    if (pending[name]) return pending[name]; // already loading

    const loader = new THREE.TextureLoader();

    const promise = new Promise((resolve, reject) => {
      loader.load(
        path,
        (texture) => {
          texture.encoding = options.encoding || THREE.sRGBEncoding;
          texture.wrapS = options.wrapS || THREE.ClampToEdgeWrapping;
          texture.wrapT = options.wrapT || THREE.ClampToEdgeWrapping;
          texture.magFilter = options.magFilter || THREE.LinearFilter;
          texture.minFilter = options.minFilter || THREE.LinearMipMapLinearFilter;

          cache[name] = texture;
          delete pending[name];
          const cloned = texture.clone();
          cloned.needsUpdate = true;
          resolve(cloned);
        },
        undefined,
        (err) => {
          console.error(`Failed to load texture: ${path}`, err);
          delete pending[name];
          reject(err);
        }
      );
    });

    pending[name] = promise;
    return promise;
  }

  return {
    get
  };
})();
