require('dotenv').config();

const express = require('express');
const mysql = require('mysql2');
const bcrypt = require('bcryptjs');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

// ========== ADDED: Import pk-pay ==========
const { configure, createPayment } = require('pk-pay');

const app = express();
app.use(cors());
app.use(express.json());

// ---------- Smart Database Configuration ----------
const dbHost = process.env.MYSQLHOST || process.env.DB_HOST;
const dbUser = process.env.MYSQLUSER || process.env.DB_USER;
const dbPassword = process.env.MYSQLPASSWORD || process.env.DB_PASSWORD;
const dbName = process.env.MYSQLDATABASE || process.env.DB_NAME;
const dbPort = process.env.MYSQLPORT || process.env.DB_PORT || 3306;

let sslConfig = {};
const isRailway = !!process.env.MYSQLHOST;
const caPath = path.join(__dirname, 'ca.pem');

if (!isRailway && fs.existsSync(caPath)) {
    sslConfig = { ssl: { ca: fs.readFileSync(caPath) } };
    console.log('🔒 SSL enabled using ca.pem (Aiven/local)');
} else {
    console.log('🔓 Connecting without SSL (Railway or no ca.pem)');
}

const pool = mysql.createPool({
    host: dbHost,
    user: dbUser,
    password: dbPassword,
    database: dbName,
    port: dbPort,
    waitForConnections: true,
    connectionLimit: 10,
    ...sslConfig
});
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

// ========== ADDED: Configure pk-pay ==========
configure({
  environment: 'sandbox', // Change to 'production' when live
  maxRetries: 3,
  // Stripe configuration (easiest for testing)
  stripe: {
    secretKey: process.env.STRIPE_SECRET_KEY, // Add to your .env
  },
  // Optional: JazzCash & EasyPaisa (uncomment if you have test credentials)
  // jazzcash: {
  //   merchantId: process.env.JAZZCASH_MERCHANT_ID,
  //   password: process.env.JAZZCASH_PASSWORD,
  //   integritySalt: process.env.JAZZCASH_INTEGRITY_SALT,
  // },
  // easypaisa: {
  //   method: 'rest',
  //   storeId: process.env.EASYPAISA_STORE_ID,
  //   privateKey: process.env.EASYPAISA_PRIVATE_KEY,
  //   username: process.env.EASYPAISA_USERNAME,
  //   password: process.env.EASYPAISA_PASSWORD,
  // },
});
console.log('✅ pk-pay configured');

// ---------- Helper: updateRecommendations ----------
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

// ---------- Public API Routes ----------
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
        user.role = user.role || 'user';
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
            `SELECT user_id, full_name, email, total_donated, created_at, role FROM users WHERE user_id = ?`,
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

// ========== ADDED: Payment Endpoint (pk-pay) ==========
app.post('/api/create-payment-intent', async (req, res) => {
    try {
        const { amount, provider, userId, charityId, isAnonymous } = req.body;

        if (!amount || amount <= 0) {
            return res.status(400).json({ error: 'Invalid amount' });
        }
        const allowedProviders = ['stripe', 'jazzcash', 'easypaisa'];
        if (!provider || !allowedProviders.includes(provider)) {
            return res.status(400).json({ error: 'Invalid payment provider' });
        }

        const payment = await createPayment({
            provider: provider,
            amount: Math.round(amount * 100), // Convert to paisa/cents
            currency: provider === 'stripe' ? 'usd' : 'pkr',
            description: `Donation to charity ${charityId} from user ${userId}`,
            returnUrl: 'zariyaapp://payment-callback',
            metadata: {
                userId: userId,
                charityId: charityId,
                isAnonymous: isAnonymous || false,
            },
        });

        res.json({
            success: true,
            paymentUrl: payment.redirectUrl || null,
            clientSecret: payment.clientSecret || null,
            paymentId: payment.id,
        });
    } catch (error) {
        console.error('Payment creation error:', error);
        res.status(500).json({ error: error.message });
    }
});
app.post('/api/mock-payment', async (req, res) => {
  const { amount, userId, charityId, isAnonymous } = req.body;
  await new Promise(resolve => setTimeout(resolve, 2000));
  res.json({
    success: true,
    message: 'Payment successful (mock)',
    transactionId: 'MOCK_' + Date.now()
  });
});
// ========== ADDED: Webhook Endpoint ==========
app.post('/api/payment-webhook', async (req, res) => {
    try {
        const event = req.body;
        console.log('Webhook received:', event);

        if (event.status === 'success' || event.type === 'payment_intent.succeeded') {
            const metadata = event.metadata || {};
            const amount = (event.amount || 0) / 100;
            const { userId, charityId, isAnonymous } = metadata;

            if (userId && charityId) {
                await promisePool.query(
                    `INSERT INTO donations (user_id, charity_id, amount, is_anonymous, payment_intent_id, status)
                     VALUES (?, ?, ?, ?, ?, 'completed')`,
                    [userId, charityId, amount, isAnonymous === 'true', event.id || 'webhook']
                );
                await promisePool.query(
                    `UPDATE charities SET total_raised = total_raised + ? WHERE charity_id = ?`,
                    [amount, charityId]
                );
                await promisePool.query(
                    `UPDATE users SET total_donated = total_donated + ? WHERE user_id = ?`,
                    [amount, userId]
                );
                console.log(`✅ Donation recorded via webhook: user ${userId}, charity ${charityId}, amount ${amount}`);
            }
        }
        res.json({ received: true });
    } catch (error) {
        console.error('Webhook error:', error);
        res.status(500).json({ error: error.message });
    }
});

// ---------- Admin Middleware ----------
async function isAdmin(req, res, next) {
    const userId = req.headers['user-id'];
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });
    const [rows] = await promisePool.query('SELECT role FROM users WHERE user_id = ?', [userId]);
    if (rows.length === 0 || rows[0].role !== 'admin') return res.status(403).json({ error: 'Admin only' });
    req.userId = userId;
    next();
}

// ---------- Admin API Routes ----------
app.get('/api/admin/ngos', isAdmin, async (req, res) => {
    const [rows] = await promisePool.query('SELECT * FROM charities ORDER BY charity_id DESC');
    res.json(rows);
});

app.post('/api/admin/ngos', isAdmin, async (req, res) => {
    const { name, description, category, location, goal_amount, impact_description, image_emoji, image_url } = req.body;
    const [result] = await promisePool.query(
        `INSERT INTO charities (name, description, category, location, goal_amount, impact_description, image_emoji, image_url)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [name, description, category, location, goal_amount, impact_description, image_emoji || '❤️', image_url || '']
    );
    res.json({ success: true, charity_id: result.insertId });
});

app.put('/api/admin/ngos/:id', isAdmin, async (req, res) => {
    const id = req.params.id;
    const updates = req.body;
    await promisePool.query('UPDATE charities SET ? WHERE charity_id = ?', [updates, id]);
    res.json({ success: true });
});

app.delete('/api/admin/ngos/:id', isAdmin, async (req, res) => {
    await promisePool.query('DELETE FROM charities WHERE charity_id = ?', [req.params.id]);
    res.json({ success: true });
});

app.get('/api/admin/donations', isAdmin, async (req, res) => {
    const [rows] = await promisePool.query(`
        SELECT d.*, c.name as charity_name, u.full_name as user_name
        FROM donations d
        JOIN charities c ON d.charity_id = c.charity_id
        JOIN users u ON d.user_id = u.user_id
        ORDER BY d.donation_date DESC
    `);
    res.json(rows);
});

app.get('/api/admin/ngo-stats', isAdmin, async (req, res) => {
    const [rows] = await promisePool.query(`
        SELECT c.charity_id, c.name, c.image_emoji, SUM(d.amount) as total_collected, COUNT(d.donation_id) as donation_count
        FROM charities c
        LEFT JOIN donations d ON c.charity_id = d.charity_id
        GROUP BY c.charity_id
    `);
    res.json(rows);
});

app.get('/api/admin/monthly-total', isAdmin, async (req, res) => {
    const [rows] = await promisePool.query(`
        SELECT SUM(amount) as total FROM donations 
        WHERE MONTH(donation_date) = MONTH(CURRENT_DATE()) AND YEAR(donation_date) = YEAR(CURRENT_DATE())
    `);
    res.json({ total: rows[0].total || 0 });
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, '0.0.0.0', () => {
    console.log(`✅ Backend running on http://0.0.0.0:${PORT}`);
});