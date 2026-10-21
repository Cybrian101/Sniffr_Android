export class StorageAdapter {
  // Resolves to { filePath, bytes } -- filePath is whatever getUrl() below
  // expects (a relative path for LocalStorage, an already-full URL for
  // CloudStorage); bytes is the *actual* stored size, which can be smaller
  // than the input file for adapters that compress on upload.
  // options.userId: owner of the file (Cloudinary tags it; local disk ignores it).
  async upload(file, subdir = '', options = {}) { throw new Error('Not implemented'); }
  async delete(filePath) { throw new Error('Not implemented'); }
  getUrl(filePath) { throw new Error('Not implemented'); }
}
