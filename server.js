require('dotenv').config();
const express = require('express');
const session = require('express-session');
const multer = require('multer');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const fs = require('fs');
const initSqlJs = require('sql.js');
const { S3Client, PutObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');

const app = express();
const PORT = process.env.PORT || 3000;

// R2 Configuration (set via environment variables)
const R2_ACCOUNT_ID = process.env.R2_ACCOUNT_ID;
const R2_ACCESS_KEY = process.env.R2_ACCESS_KEY;
const R2_SECRET_KEY = process.env.R2_SECRET_KEY;
const R2_BUCKET = process.env.R2_BUCKET || 'stepwise-videos';
const R2_PUBLIC_URL = process.env.R2_PUBLIC_URL;

const s3Client = new S3Client({
  region: 'auto',
  endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: R2_ACCESS_KEY,
    secretAccessKey: R2_SECRET_KEY,
  },
});

// Upload file to R2
async function uploadToR2(file) {
  const ext = path.extname(file.originalname);
  const key = `${Date.now()}-${uuidv4()}${ext}`;

  await s3Client.send(new PutObjectCommand({
    Bucket: R2_BUCKET,
    Key: key,
    Body: file.buffer,
    ContentType: file.mimetype,
  }));

  return `${R2_PUBLIC_URL}/${key}`;
}

// Delete file from R2
async function deleteFromR2(url) {
  if (!url || !url.startsWith(R2_PUBLIC_URL)) return;

  const key = url.replace(`${R2_PUBLIC_URL}/`, '');
  try {
    await s3Client.send(new DeleteObjectCommand({
      Bucket: R2_BUCKET,
      Key: key,
    }));
  } catch (err) {
    console.error('Failed to delete from R2:', err.message);
  }
}

// Middleware
app.set('view engine', 'ejs');
app.use(express.static('public'));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(session({
  secret: 'stepwise-secret-key-change-in-production',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 7 * 24 * 60 * 60 * 1000 } // 7 days
}));

// File upload config - use memory storage for R2 upload
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 500 * 1024 * 1024 }, // 500MB
  fileFilter: (req, file, cb) => {
    const allowed = /mp4|mov|avi|webm|mkv|pdf|doc|docx|zip/;
    const ext = allowed.test(path.extname(file.originalname).toLowerCase());
    cb(null, ext);
  }
});

// Database
let db;
const DB_FILE = 'stepwise.db';

async function initDb() {
  const SQL = await initSqlJs();
  
  // Load existing database or create new
  let data = null;
  if (fs.existsSync(DB_FILE)) {
    data = fs.readFileSync(DB_FILE);
  }
  db = new SQL.Database(data);
  
  // Create tables
  db.run(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT UNIQUE NOT NULL,
      password TEXT NOT NULL,
      name TEXT NOT NULL,
      is_admin INTEGER DEFAULT 0,
      invite_code TEXT UNIQUE,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `);
  
  db.run(`
    CREATE TABLE IF NOT EXISTS courses (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      description TEXT,
      image_url TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `);
  
  db.run(`
    CREATE TABLE IF NOT EXISTS steps (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      course_id INTEGER NOT NULL,
      title TEXT NOT NULL,
      content TEXT,
      video_url TEXT,
      position INTEGER NOT NULL,
      step_type TEXT DEFAULT 'task',
      answer_type TEXT DEFAULT 'file',
      FOREIGN KEY (course_id) REFERENCES courses(id) ON DELETE CASCADE
    )
  `);

  // Migration: add new columns if they don't exist
  try {
    db.run("ALTER TABLE steps ADD COLUMN step_type TEXT DEFAULT 'task'");
  } catch (e) {}
  try {
    db.run("ALTER TABLE steps ADD COLUMN answer_type TEXT DEFAULT 'file'");
  } catch (e) {}
  
  db.run(`
    CREATE TABLE IF NOT EXISTS enrollments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      course_id INTEGER NOT NULL,
      enrolled_at TEXT DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(user_id, course_id),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (course_id) REFERENCES courses(id) ON DELETE CASCADE
    )
  `);
  
  db.run(`
    CREATE TABLE IF NOT EXISTS step_progress (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      step_id INTEGER NOT NULL,
      status TEXT DEFAULT 'locked',
      file_url TEXT,
      text_answer TEXT,
      admin_comment TEXT,
      submitted_at TEXT,
      reviewed_at TEXT,
      UNIQUE(user_id, step_id),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (step_id) REFERENCES steps(id) ON DELETE CASCADE
    )
  `);

  // Migration: add text_answer column if it doesn't exist
  try {
    db.run("ALTER TABLE step_progress ADD COLUMN text_answer TEXT");
  } catch (e) {}

  // Create default admin if not exists
  const admin = db.exec("SELECT * FROM users WHERE is_admin = 1");
  if (admin.length === 0 || admin[0].values.length === 0) {
    const hash = bcrypt.hashSync('admin123', 10);
    db.run("INSERT INTO users (email, password, name, is_admin) VALUES (?, ?, ?, 1)", 
      ['admin@stepwise.local', hash, 'Администратор']);
    console.log('Created default admin: admin@stepwise.local / admin123');
  }
  
  saveDb();
}

function saveDb() {
  const data = db.export();
  const buffer = Buffer.from(data);
  fs.writeFileSync(DB_FILE, buffer);
}

// Helpers
function query(sql, params = []) {
  const stmt = db.prepare(sql);
  stmt.bind(params);
  const results = [];
  while (stmt.step()) {
    results.push(stmt.getAsObject());
  }
  stmt.free();
  return results;
}

function queryOne(sql, params = []) {
  const results = query(sql, params);
  return results[0] || null;
}

function run(sql, params = []) {
  db.run(sql, params);
  saveDb();
}

// Open steps for user: all info steps + first uncompleted task
// Algorithm: open consecutive steps until we hit an uncompleted task (inclusive)
function openStepsForUser(userId, courseId) {
  const steps = query(
    "SELECT * FROM steps WHERE course_id = ? ORDER BY position",
    [courseId]
  );

  for (const step of steps) {
    const progress = queryOne(
      "SELECT * FROM step_progress WHERE user_id = ? AND step_id = ?",
      [userId, step.id]
    );

    // If step is info - always open it
    if (step.step_type === 'info') {
      if (!progress) {
        run("INSERT INTO step_progress (user_id, step_id, status) VALUES (?, ?, 'completed')",
          [userId, step.id]);
      } else if (progress.status === 'locked') {
        run("UPDATE step_progress SET status = 'completed' WHERE id = ?", [progress.id]);
      }
      continue; // Move to next step
    }

    // If step is task
    if (!progress) {
      // Open this task and stop
      run("INSERT INTO step_progress (user_id, step_id, status) VALUES (?, ?, 'open')",
        [userId, step.id]);
      break;
    } else if (progress.status === 'locked') {
      // Open this task and stop
      run("UPDATE step_progress SET status = 'open' WHERE id = ?", [progress.id]);
      break;
    } else if (progress.status === 'completed') {
      // Task completed, continue to next
      continue;
    } else {
      // Task is open/pending/rejected - stop here
      break;
    }
  }
}

// Auth middleware
function requireAuth(req, res, next) {
  if (!req.session.userId) {
    return res.redirect('/login');
  }
  next();
}

function requireAdmin(req, res, next) {
  if (!req.session.userId || !req.session.isAdmin) {
    return res.redirect('/login');
  }
  next();
}

// Make user available in all views
app.use((req, res, next) => {
  res.locals.user = req.session.userId ? {
    id: req.session.userId,
    name: req.session.userName,
    isAdmin: req.session.isAdmin
  } : null;
  next();
});

// ================== PUBLIC ROUTES ==================

app.get('/', (req, res) => {
  if (req.session.userId) {
    return res.redirect(req.session.isAdmin ? '/admin' : '/dashboard');
  }
  res.render('index');
});

app.get('/login', (req, res) => {
  res.render('login', { error: null });
});

app.post('/login', (req, res) => {
  const { email, password } = req.body;
  const user = queryOne("SELECT * FROM users WHERE email = ?", [email]);
  
  if (!user || !bcrypt.compareSync(password, user.password)) {
    return res.render('login', { error: 'Неверный email или пароль' });
  }
  
  req.session.userId = user.id;
  req.session.userName = user.name;
  req.session.isAdmin = user.is_admin === 1;
  
  res.redirect(user.is_admin ? '/admin' : '/dashboard');
});

app.get('/register/:code', (req, res) => {
  const { code } = req.params;
  const invite = queryOne("SELECT * FROM users WHERE invite_code = ? AND password = ''", [code]);
  
  if (!invite) {
    return res.render('error', { message: 'Недействительный код приглашения' });
  }
  
  res.render('register', { invite, error: null });
});

app.post('/register/:code', (req, res) => {
  const { code } = req.params;
  const { name, password, password_confirm } = req.body;
  
  const invite = queryOne("SELECT * FROM users WHERE invite_code = ? AND password = ''", [code]);
  
  if (!invite) {
    return res.render('error', { message: 'Недействительный код приглашения' });
  }
  
  if (password !== password_confirm) {
    return res.render('register', { invite, error: 'Пароли не совпадают' });
  }
  
  if (password.length < 6) {
    return res.render('register', { invite, error: 'Пароль должен быть минимум 6 символов' });
  }
  
  const hash = bcrypt.hashSync(password, 10);
  run("UPDATE users SET name = ?, password = ?, invite_code = NULL WHERE id = ?", 
    [name, hash, invite.id]);
  
  req.session.userId = invite.id;
  req.session.userName = name;
  req.session.isAdmin = false;
  
  res.redirect('/dashboard');
});

app.get('/logout', (req, res) => {
  req.session.destroy();
  res.redirect('/');
});

// ================== STUDENT ROUTES ==================

app.get('/dashboard', requireAuth, (req, res) => {
  const enrollments = query(`
    SELECT c.*, e.enrolled_at,
      (SELECT COUNT(*) FROM steps WHERE course_id = c.id) as total_steps,
      (SELECT COUNT(*) FROM step_progress sp 
       JOIN steps s ON sp.step_id = s.id 
       WHERE s.course_id = c.id AND sp.user_id = ? AND sp.status = 'completed') as completed_steps
    FROM enrollments e
    JOIN courses c ON e.course_id = c.id
    WHERE e.user_id = ?
    ORDER BY e.enrolled_at DESC
  `, [req.session.userId, req.session.userId]);
  
  res.render('student/dashboard', { enrollments });
});

app.get('/course/:id', requireAuth, (req, res) => {
  const courseId = req.params.id;
  const userId = req.session.userId;
  
  // Check enrollment
  const enrollment = queryOne(
    "SELECT * FROM enrollments WHERE user_id = ? AND course_id = ?",
    [userId, courseId]
  );
  
  if (!enrollment) {
    return res.render('error', { message: 'У вас нет доступа к этому курсу' });
  }
  
  const course = queryOne("SELECT * FROM courses WHERE id = ?", [courseId]);
  
  const steps = query(`
    SELECT s.*, 
      COALESCE(sp.status, 'locked') as status,
      sp.file_url,
      sp.admin_comment,
      sp.submitted_at,
      sp.reviewed_at
    FROM steps s
    LEFT JOIN step_progress sp ON s.id = sp.step_id AND sp.user_id = ?
    WHERE s.course_id = ?
    ORDER BY s.position
  `, [userId, courseId]);
  
  res.render('student/course', { course, steps });
});

app.get('/step/:id', requireAuth, (req, res) => {
  const stepId = req.params.id;
  const userId = req.session.userId;
  
  const step = queryOne("SELECT * FROM steps WHERE id = ?", [stepId]);
  if (!step) {
    return res.render('error', { message: 'Степ не найден' });
  }
  
  // Check enrollment
  const enrollment = queryOne(
    "SELECT * FROM enrollments WHERE user_id = ? AND course_id = ?",
    [userId, step.course_id]
  );
  
  if (!enrollment) {
    return res.render('error', { message: 'У вас нет доступа к этому курсу' });
  }
  
  const progress = queryOne(
    "SELECT * FROM step_progress WHERE user_id = ? AND step_id = ?",
    [userId, stepId]
  );
  
  if (!progress || progress.status === 'locked') {
    return res.render('error', { message: 'Этот степ пока недоступен' });
  }
  
  const course = queryOne("SELECT * FROM courses WHERE id = ?", [step.course_id]);
  
  res.render('student/step', { step, progress, course });
});

app.post('/step/:id/submit', requireAuth, upload.single('file'), async (req, res) => {
  const stepId = req.params.id;
  const userId = req.session.userId;
  const { text_answer } = req.body;

  const step = queryOne("SELECT * FROM steps WHERE id = ?", [stepId]);
  const progress = queryOne(
    "SELECT * FROM step_progress WHERE user_id = ? AND step_id = ?",
    [userId, stepId]
  );

  if (!progress || progress.status === 'locked') {
    return res.redirect('/dashboard');
  }

  // Check if answer is valid based on answer_type
  const answerType = step.answer_type || 'file';
  const needsFile = answerType.includes('file');
  const needsText = answerType.includes('text');

  if (needsFile && !needsText && !req.file) {
    return res.redirect(`/step/${stepId}?error=no_file`);
  }
  if (needsText && !needsFile && !text_answer?.trim()) {
    return res.redirect(`/step/${stepId}?error=no_text`);
  }
  if (!req.file && !text_answer?.trim()) {
    return res.redirect(`/step/${stepId}?error=empty`);
  }

  try {
    // Delete old file from R2 if exists
    if (progress.file_url) {
      await deleteFromR2(progress.file_url);
    }

    // Upload new file to R2 if provided
    let fileUrl = null;
    if (req.file) {
      fileUrl = await uploadToR2(req.file);
    }

    run(`
      UPDATE step_progress
      SET file_url = ?, text_answer = ?, status = 'pending', admin_comment = NULL, submitted_at = CURRENT_TIMESTAMP
      WHERE user_id = ? AND step_id = ?
    `, [fileUrl, text_answer?.trim() || null, userId, stepId]);

    res.redirect(`/step/${stepId}?success=submitted`);
  } catch (err) {
    console.error('Upload error:', err);
    res.redirect(`/step/${stepId}?error=upload_failed`);
  }
});

// ================== ADMIN ROUTES ==================

app.get('/admin', requireAdmin, (req, res) => {
  const stats = {
    users: queryOne("SELECT COUNT(*) as count FROM users WHERE is_admin = 0")?.count || 0,
    courses: queryOne("SELECT COUNT(*) as count FROM courses")?.count || 0,
    pending: queryOne("SELECT COUNT(*) as count FROM step_progress WHERE status = 'pending'")?.count || 0
  };
  
  const pendingSubmissions = query(`
    SELECT sp.*, u.name as user_name, u.email, s.title as step_title, c.title as course_title
    FROM step_progress sp
    JOIN users u ON sp.user_id = u.id
    JOIN steps s ON sp.step_id = s.id
    JOIN courses c ON s.course_id = c.id
    WHERE sp.status = 'pending'
    ORDER BY sp.submitted_at DESC
    LIMIT 10
  `);
  
  res.render('admin/dashboard', { stats, pendingSubmissions });
});

// Users management
app.get('/admin/users', requireAdmin, (req, res) => {
  const users = query(`
    SELECT u.*,
      (SELECT COUNT(*) FROM enrollments WHERE user_id = u.id) as courses_count
    FROM users u
    WHERE u.is_admin = 0
    ORDER BY u.created_at DESC
  `);
  const baseUrl = `${req.protocol}://${req.get('host')}`;
  res.render('admin/users', { users, baseUrl });
});

app.post('/admin/users/invite', requireAdmin, (req, res) => {
  const { email } = req.body;
  const inviteCode = uuidv4().substring(0, 8);
  
  try {
    run("INSERT INTO users (email, password, name, invite_code) VALUES (?, '', '', ?)", 
      [email, inviteCode]);
    res.redirect('/admin/users?success=invited');
  } catch (e) {
    res.redirect('/admin/users?error=exists');
  }
});

app.post('/admin/users/:id/delete', requireAdmin, (req, res) => {
  run("DELETE FROM users WHERE id = ? AND is_admin = 0", [req.params.id]);
  res.redirect('/admin/users');
});

// Courses management
app.get('/admin/courses', requireAdmin, (req, res) => {
  const courses = query(`
    SELECT c.*,
      (SELECT COUNT(*) FROM steps WHERE course_id = c.id) as steps_count,
      (SELECT COUNT(*) FROM enrollments WHERE course_id = c.id) as enrolled_count
    FROM courses c
    ORDER BY c.created_at DESC
  `);
  res.render('admin/courses', { courses });
});

app.get('/admin/courses/new', requireAdmin, (req, res) => {
  res.render('admin/course-form', { course: null });
});

app.post('/admin/courses', requireAdmin, (req, res) => {
  const { title, description, image_url } = req.body;
  run("INSERT INTO courses (title, description, image_url) VALUES (?, ?, ?)",
    [title, description, image_url || null]);
  res.redirect('/admin/courses');
});

app.get('/admin/courses/:id/edit', requireAdmin, (req, res) => {
  const course = queryOne("SELECT * FROM courses WHERE id = ?", [req.params.id]);
  if (!course) return res.redirect('/admin/courses');
  res.render('admin/course-form', { course });
});

app.post('/admin/courses/:id', requireAdmin, (req, res) => {
  const { title, description, image_url } = req.body;
  run("UPDATE courses SET title = ?, description = ?, image_url = ? WHERE id = ?",
    [title, description, image_url || null, req.params.id]);
  res.redirect('/admin/courses');
});

app.post('/admin/courses/:id/delete', requireAdmin, (req, res) => {
  run("DELETE FROM courses WHERE id = ?", [req.params.id]);
  res.redirect('/admin/courses');
});

// Steps management
app.get('/admin/courses/:id/steps', requireAdmin, (req, res) => {
  const course = queryOne("SELECT * FROM courses WHERE id = ?", [req.params.id]);
  if (!course) return res.redirect('/admin/courses');
  
  const steps = query("SELECT * FROM steps WHERE course_id = ? ORDER BY position", [req.params.id]);
  res.render('admin/steps', { course, steps });
});

app.post('/admin/courses/:id/steps', requireAdmin, upload.single('video'), async (req, res) => {
  const { title, content, step_type, answer_text, answer_file } = req.body;
  const courseId = req.params.id;

  const maxPos = queryOne("SELECT MAX(position) as max FROM steps WHERE course_id = ?", [courseId]);
  const position = (maxPos?.max || 0) + 1;

  // Build answer_type from checkboxes
  let answerType = '';
  if (step_type === 'task') {
    const types = [];
    if (answer_text) types.push('text');
    if (answer_file) types.push('file');
    answerType = types.length ? types.join(',') : 'file'; // default to file
  }

  try {
    const videoUrl = req.file ? await uploadToR2(req.file) : null;

    run("INSERT INTO steps (course_id, title, content, video_url, position, step_type, answer_type) VALUES (?, ?, ?, ?, ?, ?, ?)",
      [courseId, title, content, videoUrl, position, step_type || 'task', answerType]);

    res.redirect(`/admin/courses/${courseId}/steps`);
  } catch (err) {
    console.error('Upload error:', err);
    res.redirect(`/admin/courses/${courseId}/steps?error=upload_failed`);
  }
});

app.get('/admin/steps/:id/edit', requireAdmin, (req, res) => {
  const step = queryOne("SELECT * FROM steps WHERE id = ?", [req.params.id]);
  if (!step) return res.redirect('/admin/courses');
  
  const course = queryOne("SELECT * FROM courses WHERE id = ?", [step.course_id]);
  res.render('admin/step-form', { step, course });
});

app.post('/admin/steps/:id', requireAdmin, upload.single('video'), async (req, res) => {
  const { title, content, remove_video, step_type, answer_text, answer_file } = req.body;
  const step = queryOne("SELECT * FROM steps WHERE id = ?", [req.params.id]);

  let videoUrl = step.video_url;

  // Build answer_type from checkboxes
  let answerType = '';
  if (step_type === 'task') {
    const types = [];
    if (answer_text) types.push('text');
    if (answer_file) types.push('file');
    answerType = types.length ? types.join(',') : 'file';
  }

  try {
    // Remove old video from R2 if requested or if new video uploaded
    if (remove_video === '1' || req.file) {
      if (step.video_url) {
        await deleteFromR2(step.video_url);
      }
      videoUrl = null;
    }

    // Upload new video to R2
    if (req.file) {
      videoUrl = await uploadToR2(req.file);
    }

    run("UPDATE steps SET title = ?, content = ?, video_url = ?, step_type = ?, answer_type = ? WHERE id = ?",
      [title, content, videoUrl, step_type || 'task', answerType, req.params.id]);

    res.redirect(`/admin/courses/${step.course_id}/steps`);
  } catch (err) {
    console.error('Upload error:', err);
    res.redirect(`/admin/steps/${req.params.id}/edit?error=upload_failed`);
  }
});

app.post('/admin/steps/:id/delete', requireAdmin, async (req, res) => {
  const step = queryOne("SELECT * FROM steps WHERE id = ?", [req.params.id]);

  // Delete video from R2 if exists
  if (step.video_url) {
    await deleteFromR2(step.video_url);
  }

  run("DELETE FROM steps WHERE id = ?", [req.params.id]);
  res.redirect(`/admin/courses/${step.course_id}/steps`);
});

app.post('/admin/steps/:id/move', requireAdmin, (req, res) => {
  const { direction } = req.body;
  const step = queryOne("SELECT * FROM steps WHERE id = ?", [req.params.id]);
  
  if (direction === 'up' && step.position > 1) {
    const other = queryOne(
      "SELECT * FROM steps WHERE course_id = ? AND position = ?",
      [step.course_id, step.position - 1]
    );
    if (other) {
      run("UPDATE steps SET position = ? WHERE id = ?", [step.position, other.id]);
      run("UPDATE steps SET position = ? WHERE id = ?", [step.position - 1, step.id]);
    }
  } else if (direction === 'down') {
    const other = queryOne(
      "SELECT * FROM steps WHERE course_id = ? AND position = ?",
      [step.course_id, step.position + 1]
    );
    if (other) {
      run("UPDATE steps SET position = ? WHERE id = ?", [step.position, other.id]);
      run("UPDATE steps SET position = ? WHERE id = ?", [step.position + 1, step.id]);
    }
  }
  
  res.redirect(`/admin/courses/${step.course_id}/steps`);
});

// Enrollments
app.get('/admin/enrollments', requireAdmin, (req, res) => {
  const users = query("SELECT * FROM users WHERE is_admin = 0 ORDER BY name");
  const courses = query("SELECT * FROM courses ORDER BY title");
  
  const enrollments = query(`
    SELECT e.*, u.name as user_name, u.email, c.title as course_title
    FROM enrollments e
    JOIN users u ON e.user_id = u.id
    JOIN courses c ON e.course_id = c.id
    ORDER BY e.enrolled_at DESC
  `);
  
  res.render('admin/enrollments', { users, courses, enrollments });
});

app.post('/admin/enrollments', requireAdmin, (req, res) => {
  const { user_id, course_id } = req.body;

  // Create enrollment
  try {
    run("INSERT INTO enrollments (user_id, course_id) VALUES (?, ?)", [user_id, course_id]);
  } catch (e) {
    // Already enrolled
    return res.redirect('/admin/enrollments?error=exists');
  }

  // Open steps using smart algorithm (info auto-complete, first task open)
  openStepsForUser(user_id, course_id);

  res.redirect('/admin/enrollments');
});

app.post('/admin/enrollments/:id/delete', requireAdmin, (req, res) => {
  const enrollment = queryOne("SELECT * FROM enrollments WHERE id = ?", [req.params.id]);
  if (enrollment) {
    run("DELETE FROM step_progress WHERE user_id = ? AND step_id IN (SELECT id FROM steps WHERE course_id = ?)",
      [enrollment.user_id, enrollment.course_id]);
    run("DELETE FROM enrollments WHERE id = ?", [req.params.id]);
  }
  res.redirect('/admin/enrollments');
});

// Submissions review
app.get('/admin/submissions', requireAdmin, (req, res) => {
  const submissions = query(`
    SELECT sp.*, u.name as user_name, u.email, s.title as step_title, 
           c.title as course_title, c.id as course_id
    FROM step_progress sp
    JOIN users u ON sp.user_id = u.id
    JOIN steps s ON sp.step_id = s.id
    JOIN courses c ON s.course_id = c.id
    WHERE sp.status = 'pending'
    ORDER BY sp.submitted_at ASC
  `);
  
  res.render('admin/submissions', { submissions });
});

app.get('/admin/submissions/:id', requireAdmin, (req, res) => {
  const submission = queryOne(`
    SELECT sp.*, u.name as user_name, u.email, s.title as step_title, 
           s.content as step_content, s.position as step_position,
           c.title as course_title, c.id as course_id
    FROM step_progress sp
    JOIN users u ON sp.user_id = u.id
    JOIN steps s ON sp.step_id = s.id
    JOIN courses c ON s.course_id = c.id
    WHERE sp.id = ?
  `, [req.params.id]);
  
  if (!submission) return res.redirect('/admin/submissions');
  
  res.render('admin/submission-review', { submission });
});

app.post('/admin/submissions/:id/reject', requireAdmin, (req, res) => {
  const { comment } = req.body;
  run(`
    UPDATE step_progress 
    SET status = 'rejected', admin_comment = ?, reviewed_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `, [comment, req.params.id]);
  
  res.redirect('/admin/submissions');
});

app.post('/admin/submissions/:id/approve', requireAdmin, (req, res) => {
  const submission = queryOne("SELECT * FROM step_progress WHERE id = ?", [req.params.id]);
  const step = queryOne("SELECT * FROM steps WHERE id = ?", [submission.step_id]);

  // Mark as completed
  run(`
    UPDATE step_progress
    SET status = 'completed', admin_comment = NULL, reviewed_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `, [req.params.id]);

  // Open next steps (handles info auto-completion)
  openStepsForUser(submission.user_id, step.course_id);

  res.redirect('/admin/submissions');
});

// Progress overview
app.get('/admin/progress', requireAdmin, (req, res) => {
  const courses = query("SELECT * FROM courses ORDER BY title");
  const courseId = req.query.course;
  
  let progress = [];
  let selectedCourse = null;
  
  if (courseId) {
    selectedCourse = queryOne("SELECT * FROM courses WHERE id = ?", [courseId]);
    
    progress = query(`
      SELECT u.id as user_id, u.name, u.email,
        (SELECT COUNT(*) FROM steps WHERE course_id = ?) as total_steps,
        (SELECT COUNT(*) FROM step_progress sp 
         JOIN steps s ON sp.step_id = s.id 
         WHERE s.course_id = ? AND sp.user_id = u.id AND sp.status = 'completed') as completed_steps,
        (SELECT COUNT(*) FROM step_progress sp 
         JOIN steps s ON sp.step_id = s.id 
         WHERE s.course_id = ? AND sp.user_id = u.id AND sp.status = 'pending') as pending_steps
      FROM users u
      JOIN enrollments e ON u.id = e.user_id
      WHERE e.course_id = ?
      ORDER BY u.name
    `, [courseId, courseId, courseId, courseId]);
  }
  
  res.render('admin/progress', { courses, progress, selectedCourse });
});

app.get('/admin/progress/:userId/:courseId', requireAdmin, (req, res) => {
  const { userId, courseId } = req.params;
  
  const user = queryOne("SELECT * FROM users WHERE id = ?", [userId]);
  const course = queryOne("SELECT * FROM courses WHERE id = ?", [courseId]);
  
  const steps = query(`
    SELECT s.*, 
      COALESCE(sp.status, 'locked') as status,
      sp.file_url,
      sp.admin_comment,
      sp.submitted_at,
      sp.reviewed_at,
      sp.id as progress_id
    FROM steps s
    LEFT JOIN step_progress sp ON s.id = sp.step_id AND sp.user_id = ?
    WHERE s.course_id = ?
    ORDER BY s.position
  `, [userId, courseId]);
  
  res.render('admin/user-progress', { user, course, steps });
});

app.post('/admin/progress/:userId/:stepId/open', requireAdmin, (req, res) => {
  const { userId, stepId } = req.params;
  const step = queryOne("SELECT * FROM steps WHERE id = ?", [stepId]);
  
  const existing = queryOne(
    "SELECT * FROM step_progress WHERE user_id = ? AND step_id = ?",
    [userId, stepId]
  );
  
  if (!existing) {
    run("INSERT INTO step_progress (user_id, step_id, status) VALUES (?, ?, 'open')",
      [userId, stepId]);
  } else {
    run("UPDATE step_progress SET status = 'open' WHERE id = ?", [existing.id]);
  }
  
  res.redirect(`/admin/progress/${userId}/${step.course_id}`);
});

// Start server
initDb().then(() => {
  app.listen(PORT, () => {
    console.log(`\n🎓 Stepwise LMS запущен на http://localhost:${PORT}`);
    console.log(`\n📝 Админ: admin@stepwise.local / admin123\n`);
  });
});
