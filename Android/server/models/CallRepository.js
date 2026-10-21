import BaseRepository from './BaseRepository.js';
import db from '../db/connection.js';
import { sqlPetName, sqlHidden, sqlGone } from '../utils/sniffedOut.js';

class CallRepository extends BaseRepository {
  constructor() { super('calls'); }

  /**
   * Get call history for a pet, with direction resolved per-pet.
   * direction: 'outgoing' if caller, 'incoming' if receiver
   */
  async getHistory(petId) {
    // Calls with a SniffedOut pet stay in the history, shown as "SniffedOut"
    // with no avatar (and can't be called back -- see socket/calls.js).
    const rows = await db.all(`
      SELECT c.*,
        ${sqlPetName('p1', 'u1')} as caller_name, ${sqlHidden('p1.avatar_url', 'p1', 'u1')} as caller_avatar,
        ${sqlGone('p1', 'u1')} as caller_sniffed_out,
        ${sqlPetName('p2', 'u2')} as receiver_name, ${sqlHidden('p2.avatar_url', 'p2', 'u2')} as receiver_avatar,
        ${sqlGone('p2', 'u2')} as receiver_sniffed_out
      FROM calls c
      JOIN pets p1 ON c.caller_pet_id = p1.id
      JOIN pets p2 ON c.receiver_pet_id = p2.id
      LEFT JOIN users u1 ON u1.id = p1.user_id
      LEFT JOIN users u2 ON u2.id = p2.user_id
      WHERE c.caller_pet_id = ? OR c.receiver_pet_id = ?
      ORDER BY c.created_at DESC
      LIMIT 100
    `, [petId, petId]);

    return rows.map(row => {
      const outgoing = row.caller_pet_id === petId;
      return {
        ...row,
        direction: outgoing ? 'outgoing' : 'incoming',
        // partner is the other party from this pet's perspective
        partner_name: outgoing ? row.receiver_name : row.caller_name,
        partner_avatar: outgoing ? row.receiver_avatar : row.caller_avatar,
        sniffed_out: outgoing ? row.receiver_sniffed_out : row.caller_sniffed_out,
      };
    });
  }

  async log({ callerPetId, receiverPetId, type, status, duration = 0, declinedBy = null, start_time = null, end_time = null }) {
    const result = await db.run(
      `INSERT INTO calls (caller_pet_id, receiver_pet_id, type, status, duration, declined_by, start_time, end_time)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
      [callerPetId, receiverPetId, type, status, duration, declinedBy, start_time, end_time]
    );
    return db.get('SELECT * FROM calls WHERE id = ?', [result.rows[0].id]);
  }
}

export default new CallRepository();