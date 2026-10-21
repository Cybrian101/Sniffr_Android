import db from '../db/connection.js';

export default class BaseRepository {
  constructor(tableName) {
    this.table = tableName;
  }

  async findById(id) {
    return db.get(`SELECT * FROM ${this.table} WHERE id = ?`, [id]);
  }

  async findAll({ where = {}, orderBy = 'created_at DESC', page = 1, limit = 20 } = {}) {
    const conditions = Object.keys(where);
    const values = Object.values(where);
    const whereClause = conditions.length
      ? 'WHERE ' + conditions.map(k => `${k} = ?`).join(' AND ')
      : '';
    const offset = (page - 1) * limit;
    return db.all(
      `SELECT * FROM ${this.table} ${whereClause} ORDER BY ${orderBy} LIMIT ? OFFSET ?`,
      [...values, limit, offset]
    );
  }

  async create(data) {
    const keys = Object.keys(data);
    const placeholders = keys.map(() => '?').join(', ');
    // RETURNING * gives us the full new row back — replaces sqlite's lastInsertRowid trick
    const result = await db.run(
      `INSERT INTO ${this.table} (${keys.join(', ')}) VALUES (${placeholders}) RETURNING *`,
      Object.values(data)
    );
    return result.rows[0];
  }

  async update(id, data) {
    const keys = Object.keys(data);
    const setClause = keys.map(k => `${k} = ?`).join(', ');
    await db.run(`UPDATE ${this.table} SET ${setClause} WHERE id = ?`, [...Object.values(data), id]);
    return this.findById(id);
  }

  async delete(id) {
    return db.run(`DELETE FROM ${this.table} WHERE id = ?`, [id]);
  }

  async count(where = {}) {
    const conditions = Object.keys(where);
    const values = Object.values(where);
    const whereClause = conditions.length
      ? 'WHERE ' + conditions.map(k => `${k} = ?`).join(' AND ')
      : '';
    const row = await db.get(`SELECT COUNT(*) as count FROM ${this.table} ${whereClause}`, values);
    return Number(row.count);
  }
}