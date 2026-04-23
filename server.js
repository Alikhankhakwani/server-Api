require('dotenv').config();
const express = require('express');
const sql = require('mssql');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

const config = {
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    server: process.env.DB_SERVER,
    port: parseInt(process.env.DB_PORT) || 1433,
    database: process.env.DB_NAME,
    options: {
        encrypt: false,
        trustServerCertificate: true,
        enableArithAbort: true,
        connectTimeout: 30000,
        requestTimeout: 30000
    },
    pool: {
        max: 10,
        min: 0,
        idleTimeoutMillis: 30000
    }
};

// ── Single pool instance ────────────────────────────────────────────────────
const poolPromise = new sql.ConnectionPool(config)
    .connect()
    .then(pool => {
        console.log('✅ Connected to DHA SQL Server');
        return pool;
    })
    .catch(err => {
        console.warn('⚠️ DB connection failed:', err.message);
        return null;
    });

async function getConnection() {
    const pool = await poolPromise;
    if (!pool) throw new Error('Database connection not available');
    return pool;
}

// ── Helper: Parse any date format ──────────────────────────────────────────
function parseDateParts(value) {
    if (!value) return null;
    const str = value.toString().trim();

    const dmyMatch = str.match(/^(\d{1,2})[-\/](\d{1,2})[-\/](\d{4})$/);
    if (dmyMatch) {
        return {
            day: parseInt(dmyMatch[1]),
            month: parseInt(dmyMatch[2]),
            year: parseInt(dmyMatch[3])
        };
    }

    const ymdMatch = str.match(/^(\d{4})[-\/](\d{2})[-\/](\d{2})/);
    if (ymdMatch) {
        return {
            day: parseInt(ymdMatch[3]),
            month: parseInt(ymdMatch[2]),
            year: parseInt(ymdMatch[1])
        };
    }

    const digits = str.replace(/\D/g, '');
    if (digits.length === 8) {
        return {
            day: parseInt(digits.substring(0, 2)),
            month: parseInt(digits.substring(2, 4)),
            year: parseInt(digits.substring(4, 8))
        };
    }

    return null;
}

// ── Health check ────────────────────────────────────────────────────────────
app.get('/test', async (req, res) => {
    try {
        await getConnection();
        res.send('✅ DHA Bot API running!');
    } catch (err) {
        res.status(500).send('❌ ' + err.message);
    }
});

// ── Debug member ────────────────────────────────────────────────────────────
app.post('/debugMember', async (req, res) => {
    const { appId } = req.body;
    try {
        const db = await getConnection();
        const result = await db.request()
            .input('appId', sql.Int, appId || 1)
            .query(`SELECT TOP 1 * FROM BaseMembers WHERE AppID = @appId`);
        res.json({
            columns: result.recordset.length > 0 ? Object.keys(result.recordset[0]) : [],
            data: result.recordset[0] || {}
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ── 1. Get plots by phone ───────────────────────────────────────────────────
app.post('/getPlotsByPhone', async (req, res) => {
    const { phone } = req.body;
    if (!phone) return res.status(400).json({ error: 'Phone required' });

    try {
        const db = await getConnection();
        const cleaned = phone.replace(/[-\s+]/g, '');
        const digits10 = cleaned.replace(/^0/, '').replace(/^92/, '');

        console.log('📞 Phone lookup:', { phone, cleaned, digits10 });

        const result = await db.request()
            .input('phone', sql.VarChar(50), phone)
            .input('cleaned', sql.VarChar(50), cleaned)
            .input('digits10', sql.VarChar(50), digits10)
            .query(`
                SELECT 
                    AppID, Name, FatherName, RefrenceNo,
                    MembershipNo, PlotSize, PlotCategory,
                    PlotStatus, Mobile, CNIC, DOB
                FROM dbo.BaseMembers
                WHERE IsCancelled = 0 AND InActive = 0
                  AND (
                    Mobile = @phone
                    OR Mobile = @cleaned
                    OR Mobile = '0' + @digits10
                    OR Mobile = '92' + @digits10
                    OR Mobile = '+92' + @digits10
                    OR REPLACE(REPLACE(REPLACE(Mobile,'-',''),' ',''),'+','') = @cleaned
                    OR RIGHT(REPLACE(REPLACE(REPLACE(Mobile,'-',''),' ',''),'+',''), 10) = RIGHT(@cleaned, 10)
                    OR PhoneNo = @phone
                    OR PhoneNo = @cleaned
                  )
                ORDER BY RefrenceNo;
            `);

        console.log('✅ Found:', result.recordset.length, 'records');
        if (result.recordset.length > 0) {
            console.log('🔍 CNIC:', result.recordset[0].CNIC);
            console.log('🔍 DOB raw:', result.recordset[0].DOB);
        }

        res.json({
            success: true,
            count: result.recordset.length,
            data: result.recordset || []
        });
    } catch (err) {
        console.error('❌ getPlotsByPhone error:', err.message);
        res.status(500).json({ success: false, error: err.message });
    }
});

// ── 2. Verify CNIC ──────────────────────────────────────────────────────────
app.post('/verifyCnic', async (req, res) => {
    const { appId, cnic } = req.body;
    if (!appId || !cnic) return res.status(400).json({ error: 'AppID and CNIC required' });

    try {
        const db = await getConnection();
        const cleanInput = cnic.toString().replace(/[-\s]/g, '').trim();

        const result = await db.request()
            .input('appId', sql.Int, appId)
            .query(`
                SELECT CNIC FROM BaseMembers 
                WHERE AppID = @appId AND CNIC IS NOT NULL AND CNIC != ''
            `);

        if (!result.recordset.length || !result.recordset[0].CNIC) {
            return res.json({ success: false, notFound: true, error: 'CNIC not in database' });
        }

        const storedCnic = result.recordset[0].CNIC.toString().replace(/[-\s]/g, '').trim();
        const isMatch = storedCnic === cleanInput;

        console.log(`🔐 CNIC verify AppID ${appId}: input=${cleanInput}, stored=${storedCnic}, match=${isMatch}`);
        res.json({ success: true, match: isMatch });
    } catch (err) {
        console.error('❌ verifyCnic error:', err.message);
        res.status(500).json({ success: false, error: err.message });
    }
});

// ── 3. Verify DOB ───────────────────────────────────────────────────────────
app.post('/verifyDob', async (req, res) => {
    const { appId, dob } = req.body;
    if (!appId || !dob) return res.status(400).json({ error: 'AppID and DOB required' });

    try {
        const db = await getConnection();

        const result = await db.request()
            .input('appId', sql.Int, appId)
            .query(`
                SELECT DOB FROM BaseMembers 
                WHERE AppID = @appId AND DOB IS NOT NULL AND DOB != ''
            `);

        if (!result.recordset.length || !result.recordset[0].DOB) {
            return res.json({ success: false, notFound: true, error: 'DOB not in database' });
        }

        const rawStoredDob = result.recordset[0].DOB;
        const storedParts = parseDateParts(rawStoredDob);
        if (!storedParts) {
            return res.json({ success: false, error: 'Could not parse stored DOB', rawDob: rawStoredDob });
        }

        const inputParts = parseDateParts(dob);
        if (!inputParts) {
            return res.json({ success: false, match: false, error: 'Could not parse input DOB' });
        }

        const isMatch = (
            storedParts.day === inputParts.day &&
            storedParts.month === inputParts.month &&
            storedParts.year === inputParts.year
        );

        console.log(`📅 DOB verify AppID ${appId}: input=${inputParts.day}/${inputParts.month}/${inputParts.year} stored=${storedParts.day}/${storedParts.month}/${storedParts.year} match=${isMatch}`);
        res.json({ success: true, match: isMatch });
    } catch (err) {
        console.error('❌ verifyDob error:', err.message);
        res.status(500).json({ success: false, error: err.message });
    }
});

// ── 4. Get balance ──────────────────────────────────────────────────────────
app.post('/getBalance', async (req, res) => {
    const { appId } = req.body;
    if (!appId) return res.status(400).json({ error: 'AppID required' });

    try {
        const db = await getConnection();

        const memberRes = await db.request()
            .input('appId', sql.Int, appId)
            .query(`
                SELECT AppID, Name, FatherName, RefrenceNo, MembershipNo,
                       PlotSize, PlotCategory, PlotStatus
                FROM BaseMembers WHERE AppID = @appId
            `);

        if (!memberRes.recordset.length)
            return res.status(404).json({ success: false, error: 'Member not found' });

        const member = memberRes.recordset[0];

        const scheduledRes = await db.request()
            .input('plotCategory', sql.Int, member.PlotCategory)
            .input('plotSize', sql.Int, member.PlotSize)
            .query(`
                SELECT ISNULL(SUM(Amount), 0) as TotalScheduled, COUNT(*) as InstallmentCount
                FROM InstallmentShcedule
                WHERE PlotCategoryID = @plotCategory AND PlotSizeID = @plotSize
            `);

        const paidRes = await db.request()
            .input('appId', sql.Int, appId)
            .query(`
                SELECT ISNULL(SUM(Amount), 0) as TotalPaid, COUNT(*) as PaymentCount,
                       MAX(RecevingDate) as LastPaymentDate, MIN(RecevingDate) as FirstPaymentDate
                FROM InstallmentPaymentRecieving
                WHERE MemberID = @appId
            `);

        const recentRes = await db.request()
            .input('appId', sql.Int, appId)
            .query(`
                SELECT TOP 5 Amount, RecevingDate, BranchName, ChallanNo, PaymentMode
                FROM InstallmentPaymentRecieving
                WHERE MemberID = @appId
                ORDER BY RecevingDate DESC
            `);

        const totalScheduled = scheduledRes.recordset[0].TotalScheduled;
        const totalPaid = paidRes.recordset[0].TotalPaid;
        const pendingBalance = Math.max(0, totalScheduled - totalPaid);

        console.log(`💰 Balance for AppID ${appId}: Scheduled=${totalScheduled}, Paid=${totalPaid}, Pending=${pendingBalance}`);

        res.json({
            success: true,
            data: {
                member, totalScheduled, totalPaid, pendingBalance,
                installmentCount: scheduledRes.recordset[0].InstallmentCount,
                paymentCount: paidRes.recordset[0].PaymentCount,
                lastPaymentDate: paidRes.recordset[0].LastPaymentDate,
                firstPaymentDate: paidRes.recordset[0].FirstPaymentDate,
                recentPayments: recentRes.recordset
            }
        });
    } catch (err) {
        console.error('❌ getBalance error:', err.message);
        res.status(500).json({ success: false, error: err.message });
    }
});

// ── 5. Get payment history ──────────────────────────────────────────────────
app.post('/getPaymentHistory', async (req, res) => {
    const { appId } = req.body;
    if (!appId) return res.status(400).json({ error: 'AppID required' });

    try {
        const db = await getConnection();

        const result = await db.request()
            .input('appId', sql.Int, appId)
            .query(`
                SELECT Amount, RecevingDate, BranchName,
                       ChallanNo, PaymentMode, RecieptNo, IsLate, DueDate
                FROM InstallmentPaymentRecieving
                WHERE MemberID = @appId
                ORDER BY RecevingDate DESC
            `);

        console.log(`📋 Payment history for AppID ${appId}: ${result.recordset.length} records`);
        res.json({ success: true, count: result.recordset.length, data: result.recordset });
    } catch (err) {
        console.error('❌ getPaymentHistory error:', err.message);
        res.status(500).json({ success: false, error: err.message });
    }
});

// ── 6. Debug phone ──────────────────────────────────────────────────────────
app.post('/debugPhone', async (req, res) => {
    const { phone } = req.body;
    if (!phone) return res.status(400).json({ error: 'Phone required' });

    try {
        const db = await getConnection();

        const sample = await db.request().query(`
            SELECT TOP 10 AppID, Name, Mobile, PhoneNo, CNIC, DOB
            FROM BaseMembers 
            WHERE Mobile IS NOT NULL AND Mobile != ''
            ORDER BY AppID DESC
        `);

        const exact = await db.request()
            .input('phone', sql.VarChar(50), phone)
            .query(`
                SELECT AppID, Name, Mobile, PhoneNo, CNIC, DOB
                FROM BaseMembers
                WHERE Mobile = @phone OR PhoneNo = @phone
            `);

        res.json({ input: phone, sampleMobilesInDB: sample.recordset, exactMatches: exact.recordset });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// ── Start server ────────────────────────────────────────────────────────────
app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 DHA Bot API running on http://0.0.0.0:${PORT}`);
});