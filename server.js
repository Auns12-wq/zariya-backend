require('dotenv').config();
require('dotenv').config();
const express = require('express');
const mysql = require('mysql2');
const bcrypt = require('bcryptjs');
const cors = require('cors');
const fs = require('fs');

const app = express();
app.use(cors());
app.use(express.json());

const pool = mysql.createPool({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    port: process.env.DB_PORT,
    ssl: {
        ca: fs.readFileSync('./ca.pem') // Path to your downloaded file
    },
    waitForConnections: true,
    connectionLimit: 10
})
const promisePool = pool.promise();

// Test database connection
(async () => {
    try {
        const [rows] = await promisePool.query('SELECT 1');
        console.log('✅ MySQL connected successfully');
    } catch (err) {
        console.error('❌ MySQL connection failed:', err.message);
    }
})();

// Helper: Generate/update recommendations
async function updateRecommendations(userId) {
    try {
        const [history] = await promisePool.query(
            `SELECT c.category, SUM(d.amount) as total
             FROM donations d
             JOIN charities c ON d.charity_id = c.charity_id
             WHERE d.user_id = ?
             GROUP BY c.category
             ORDER BY total DESC`, [userId]
        );
        let interests = {};
        if (history.length === 0) {
            const [popular] = await promisePool.query(
                `SELECT charity_id, 2.0 as score, 'Popular in Pakistan' as reason
                 FROM charities ORDER BY RAND() LIMIT 10`
            );
            await promisePool.query('DELETE FROM recommendations WHERE user_id = ?', [userId]);
            for (let rec of popular) {
                await promisePool.query(
                    `INSERT INTO recommendations (user_id, charity_id, score, reason)
                     VALUES (?, ?, ?, ?)`, [userId, rec.charity_id, rec.score, rec.reason]
                );
            }
            return;
        }
        let caseStmt = 'CASE ';
        for (let h of history) caseStmt += `WHEN category = '${h.category}' THEN ${h.total} `;
        caseStmt += 'ELSE 0 END';
        const [scored] = await promisePool.query(
            `SELECT charity_id, ${caseStmt} as score,
             CONCAT('Based on your support for ', category) as reason
             FROM charities
             HAVING score > 0
             ORDER BY score DESC
             LIMIT 15`
        );
        await promisePool.query('DELETE FROM recommendations WHERE user_id = ?', [userId]);
        for (let rec of scored) {
            await promisePool.query(
                `INSERT INTO recommendations (user_id, charity_id, score, reason)
                 VALUES (?, ?, ?, ?)`, [userId, rec.charity_id, rec.score, rec.reason]
            );
        }
    } catch (err) {
        console.error('Error in updateRecommendations:', err);
    }
}

// ---------- API Routes ----------
app.get('/api/categories', async (req, res) => {
    try {
        const [rows] = await promisePool.query(`SELECT DISTINCT category FROM charities`);
        res.json(rows.map(r => r.category));
    } catch (err) {
        console.error('Error in /api/categories:', err);
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/ngos/general', async (req, res) => {
    try {
        const [rows] = await promisePool.query(`SELECT *, 0 as score, 'Featured NGO' as reason FROM charities ORDER BY rating DESC LIMIT 20`);
        res.json(rows);
    } catch (err) {
        console.error('Error in /api/ngos/general:', err);
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/recommendations/:userId', async (req, res) => {
    const userId = parseInt(req.params.userId);
    try {
        const [recs] = await promisePool.query(
            `SELECT c.*, r.score, r.reason
             FROM recommendations r
             JOIN charities c ON r.charity_id = c.charity_id
             WHERE r.user_id = ?
             ORDER BY r.score DESC`, [userId]
        );
        res.json(recs);
    } catch (err) {
        console.error('Error in /api/recommendations:', err);
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/ngos/category/:cat', async (req, res) => {
    const cat = req.params.cat;
    try {
        const [rows] = await promisePool.query(`SELECT * FROM charities WHERE category = ? ORDER BY rating DESC`, [cat]);
        res.json(rows);
    } catch (err) {
        console.error('Error in /api/ngos/category:', err);
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/ngos/search', async (req, res) => {
    const query = req.query.q || '';
    try {
        const [rows] = await promisePool.query(
            `SELECT * FROM charities WHERE name LIKE ? OR description LIKE ? OR location LIKE ?`,
            [`%${query}%`, `%${query}%`, `%${query}%`]
        );
        res.json(rows);
    } catch (err) {
        console.error('Error in /api/ngos/search:', err);
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/ngos/:id', async (req, res) => {
    const id = req.params.id;
    try {
        const [rows] = await promisePool.query('SELECT * FROM charities WHERE charity_id = ?', [id]);
        if (rows.length === 0) return res.status(404).json({ error: 'Not found' });
        res.json(rows[0]);
    } catch (err) {
        console.error('Error in /api/ngos/:id:', err);
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/register', async (req, res) => {
    const { full_name, email, password } = req.body;
    if (!full_name || !email || !password) return res.status(400).json({ error: 'Missing fields' });
    try {
        const hashed = await bcrypt.hash(password, 10);
        const [result] = await promisePool.query(
            'INSERT INTO users (full_name, email, password_hash) VALUES (?, ?, ?)',
            [full_name, email, hashed]
        );
        await promisePool.query(
            'INSERT INTO user_interests (user_id, category, weight) VALUES (?, "education", 1), (?, "health", 1), (?, "poverty", 1)',
            [result.insertId, result.insertId, result.insertId]
        );
        await updateRecommendations(result.insertId);
        res.json({ success: true, user_id: result.insertId });
    } catch (err) {
        console.error('Error in /api/register:', err);
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/login', async (req, res) => {
    const { email, password } = req.body;
    try {
        const [rows] = await promisePool.query('SELECT * FROM users WHERE email = ?', [email]);
        if (rows.length === 0) return res.status(401).json({ error: 'Invalid credentials' });
        const user = rows[0];
        const valid = await bcrypt.compare(password, user.password_hash);
        if (!valid) return res.status(401).json({ error: 'Invalid credentials' });
        delete user.password_hash;
        res.json({ success: true, user, token: user.user_id.toString() });
    } catch (err) {
        console.error('Error in /api/login:', err);
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/donate', async (req, res) => {
    const { user_id, charity_id, amount, is_anonymous } = req.body;
    if (!user_id) return res.status(401).json({ error: 'Authentication required' });
    try {
        await promisePool.query(
            `INSERT INTO donations (user_id, charity_id, amount, is_anonymous) VALUES (?, ?, ?, ?)`,
            [user_id, charity_id, amount, is_anonymous || false]
        );
        await promisePool.query(`UPDATE charities SET total_raised = total_raised + ? WHERE charity_id = ?`, [amount, charity_id]);
        await promisePool.query(`UPDATE users SET total_donated = total_donated + ? WHERE user_id = ?`, [amount, user_id]);
        const [cat] = await promisePool.query(`SELECT category FROM charities WHERE charity_id = ?`, [charity_id]);
        if (cat.length) {
            await promisePool.query(
                `INSERT INTO user_interests (user_id, category, weight) VALUES (?, ?, 1) ON DUPLICATE KEY UPDATE weight = weight + 1`,
                [user_id, cat[0].category]
            );
        }
        await updateRecommendations(user_id);
        res.json({ success: true, message: 'Donation successful' });
    } catch (err) {
        console.error('Error in /api/donate:', err);
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/history/:userId', async (req, res) => {
    const userId = req.params.userId;
    try {
        const [rows] = await promisePool.query(
            `SELECT d.*, c.name as charity_name, c.category, c.image_emoji
             FROM donations d
             JOIN charities c ON d.charity_id = c.charity_id
             WHERE d.user_id = ?
             ORDER BY d.donation_date DESC`, [userId]
        );
        res.json(rows);
    } catch (err) {
        console.error('Error in /api/history:', err);
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/profile/:userId', async (req, res) => {
    const userId = req.params.userId;
    try {
        const [rows] = await promisePool.query(
            `SELECT user_id, full_name, email, total_donated, created_at FROM users WHERE user_id = ?`,
            [userId]
        );
        if (rows.length === 0) return res.status(404).json({ error: 'User not found' });
        const user = rows[0];
        const [interests] = await promisePool.query(
            `SELECT category FROM user_interests WHERE user_id = ? ORDER BY weight DESC`, [userId]
        );
        user.interests = interests.map(i => i.category);
        res.json(user);
    } catch (err) {
        console.error('Error in /api/profile:', err);
        res.status(500).json({ error: err.message });
    }
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, '0.0.0.0', () => {
    console.log(`✅ Backend running on http://0.0.0.0:${PORT}`);
});