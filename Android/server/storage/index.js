import config from '../config.js';
import LocalStorage from './LocalStorage.js';
import CloudStorage from './CloudStorage.js';

const storage = config.STORAGE_TYPE === 'cloud' ? CloudStorage : LocalStorage;

console.log(`📦 Using ${config.STORAGE_TYPE === 'cloud' ? 'Cloudinary (cloud)' : 'local disk'} storage`);

export default storage;