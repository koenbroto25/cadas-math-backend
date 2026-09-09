/**
 * Level Access Middleware — FASE 6 & 8
 * Determines access type for a student at a given level.
 * Returns: 'locked' | 'basic' | 'premium'
 */

async function getLevelAccess(pool, studentId, level) {
  const student = await pool.query(
    `SELECT paid_basic_up_to_level, paid_premium_up_to_level
     FROM students WHERE id = $1`,
    [studentId]
  );

  if (student.rows.length === 0) {
    return 'locked';
  }

  const s = student.rows[0];
  const lvl = parseInt(level, 10);

  // Check premium access first (higher tier)
  if (s.paid_premium_up_to_level !== null && s.paid_premium_up_to_level >= lvl) {
    return 'premium';
  }

  // Check basic access
  if (s.paid_basic_up_to_level !== null && s.paid_basic_up_to_level >= lvl) {
    return 'basic';
  }

  // Level not purchased
  return 'locked';
}

/**
 * Express middleware to check level access.
 * Attaches req.levelAccess = 'locked' | 'basic' | 'premium'
 */
function checkLevelAccess(paramName = 'level') {
  return async (req, res, next) => {
    try {
      const studentId = req.user?.id || req.body?.student_id || req.query?.student_id;
      const level = req.params[paramName] || req.body?.level || req.query?.level;

      if (!studentId || !level) {
        return res.status(400).json({ error: 'student_id and level are required' });
      }

      const { Pool } = require('pg');
      const pool = new Pool({
        host: process.env.DB_HOST || 'localhost',
        port: parseInt(process.env.DB_PORT || '5432'),
        user: process.env.DB_USER || 'postgres',
        password: process.env.DB_PASSWORD || 'postgres',
        database: process.env.DB_NAME || 'cadas_app_dev',
      });

      req.levelAccess = await getLevelAccess(pool, studentId, level);
      req.level = parseInt(level, 10);
      next();
    } catch (error) {
      next(error);
    }
  };
}

module.exports = { getLevelAccess, checkLevelAccess };
