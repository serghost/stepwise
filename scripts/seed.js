require('dotenv').config();
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');
const initSqlJs = require('sql.js');
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');

const DB_FILE = process.env.RAILWAY_VOLUME_MOUNT_PATH
  ? `${process.env.RAILWAY_VOLUME_MOUNT_PATH}/stepwise.db`
  : 'stepwise.db';

// R2 config
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

async function uploadToR2(filePath) {
  const fileName = path.basename(filePath);
  const key = `seed-${Date.now()}-${fileName}`;
  const fileBuffer = fs.readFileSync(filePath);

  await s3Client.send(new PutObjectCommand({
    Bucket: R2_BUCKET,
    Key: key,
    Body: fileBuffer,
    ContentType: 'video/mp4',
  }));

  return `${R2_PUBLIC_URL}/${key}`;
}

async function seed() {
  console.log('🌱 Starting seed...\n');

  // Delete existing DB
  if (fs.existsSync(DB_FILE)) {
    fs.unlinkSync(DB_FILE);
    console.log('🗑️  Deleted existing database');
  }

  const SQL = await initSqlJs();
  const db = new SQL.Database();

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

  // Upload videos to R2
  console.log('📹 Uploading videos to R2...');
  let videoUrl1 = null;
  let videoUrl2 = null;

  const seedDir = path.join(__dirname, '..', 'seed');
  if (fs.existsSync(path.join(seedDir, 'vid1.mp4'))) {
    videoUrl1 = await uploadToR2(path.join(seedDir, 'vid1.mp4'));
    console.log('   ✓ vid1.mp4 uploaded');
  }
  if (fs.existsSync(path.join(seedDir, 'vid2.mp4'))) {
    videoUrl2 = await uploadToR2(path.join(seedDir, 'vid2.mp4'));
    console.log('   ✓ vid2.mp4 uploaded');
  }

  // Create admin
  const adminHash = bcrypt.hashSync('admin123', 10);
  db.run(
    "INSERT INTO users (email, password, name, is_admin) VALUES (?, ?, ?, 1)",
    ['admin@stepwise.local', adminHash, 'Администратор']
  );
  console.log('\n👤 Admin: admin@stepwise.local / admin123');

  // Create users
  const userHash = bcrypt.hashSync('user123', 10);
  db.run(
    "INSERT INTO users (email, password, name, is_admin) VALUES (?, ?, ?, 0)",
    ['maria@test.ru', userHash, 'Мария Иванова']
  );
  db.run(
    "INSERT INTO users (email, password, name, is_admin) VALUES (?, ?, ?, 0)",
    ['alex@test.ru', userHash, 'Алексей Петров']
  );
  db.run(
    "INSERT INTO users (email, password, name, is_admin) VALUES (?, ?, ?, 0)",
    ['olga@test.ru', userHash, 'Ольга Сидорова']
  );
  console.log('👥 Users: maria@test.ru, alex@test.ru, olga@test.ru (password: user123)');

  // Create courses
  db.run(
    "INSERT INTO courses (title, description) VALUES (?, ?)",
    ['Основы груминга', 'Базовый курс по уходу за шерстью собак. Научитесь правильно расчёсывать, мыть и стричь.']
  );
  db.run(
    "INSERT INTO courses (title, description) VALUES (?, ?)",
    ['Стрижка пуделей', 'Продвинутый курс по породным стрижкам пуделей: лев, модерн, паппи-клип.']
  );
  console.log('\n📚 Courses: "Основы груминга", "Стрижка пуделей"');

  // Course 1 steps (Основы груминга)
  db.run(
    "INSERT INTO steps (course_id, title, content, video_url, position, step_type, answer_type) VALUES (?, ?, ?, ?, ?, ?, ?)",
    [1, 'Введение в груминг', 'Добро пожаловать на курс! В этом уроке вы узнаете, что такое груминг и почему он важен для здоровья собаки.\n\nГруминг — это комплекс процедур по уходу за внешним видом животного.', videoUrl1, 1, 'info', '']
  );
  db.run(
    "INSERT INTO steps (course_id, title, content, video_url, position, step_type, answer_type) VALUES (?, ?, ?, ?, ?, ?, ?)",
    [1, 'Инструменты грумера', 'Для работы вам понадобятся:\n\n• Расчёска-пуходёрка\n• Колтунорез\n• Ножницы прямые и филировочные\n• Машинка для стрижки\n• Фен\n\nПосмотрите видео и расскажите, какие инструменты у вас уже есть.', videoUrl2, 2, 'task', 'text']
  );
  db.run(
    "INSERT INTO steps (course_id, title, content, video_url, position, step_type, answer_type) VALUES (?, ?, ?, ?, ?, ?, ?)",
    [1, 'Расчёсывание шерсти', 'Научимся правильно расчёсывать собаку. Важно двигаться по направлению роста шерсти, не причиняя дискомфорта животному.\n\nСнимите видео, как вы расчёсываете собаку (или игрушку для практики).', null, 3, 'task', 'file']
  );
  db.run(
    "INSERT INTO steps (course_id, title, content, video_url, position, step_type, answer_type) VALUES (?, ?, ?, ?, ?, ?, ?)",
    [1, 'Итоговое задание', 'Поздравляем! Вы прошли базовый курс.\n\nДля получения сертификата:\n1. Напишите, что нового вы узнали\n2. Приложите фото/видео вашей работы', null, 4, 'task', 'text,file']
  );

  // Course 2 steps (Стрижка пуделей)
  db.run(
    "INSERT INTO steps (course_id, title, content, video_url, position, step_type, answer_type) VALUES (?, ?, ?, ?, ?, ?, ?)",
    [2, 'История породы', 'Пудель — одна из старейших пород. Изначально использовались как охотничьи собаки.\n\nВ этом уроке мы познакомимся с историей породы и стандартами стрижек.', videoUrl1, 1, 'info', '']
  );
  db.run(
    "INSERT INTO steps (course_id, title, content, video_url, position, step_type, answer_type) VALUES (?, ?, ?, ?, ?, ?, ?)",
    [2, 'Стрижка "Лев"', 'Классическая выставочная стрижка. Требует навыков и терпения.\n\nПосмотрите видео и опишите основные этапы стрижки.', videoUrl2, 2, 'task', 'text']
  );
  db.run(
    "INSERT INTO steps (course_id, title, content, video_url, position, step_type, answer_type) VALUES (?, ?, ?, ?, ?, ?, ?)",
    [2, 'Стрижка "Модерн"', 'Более практичная стрижка для повседневной жизни.\n\nСделайте стрижку на модели или собаке и пришлите видео процесса.', null, 3, 'task', 'file']
  );

  console.log('📝 Steps created for both courses');

  // Enrollments
  // Maria (id=2) - enrolled in both courses
  db.run("INSERT INTO enrollments (user_id, course_id) VALUES (?, ?)", [2, 1]);
  db.run("INSERT INTO enrollments (user_id, course_id) VALUES (?, ?)", [2, 2]);

  // Alex (id=3) - enrolled in course 1 only
  db.run("INSERT INTO enrollments (user_id, course_id) VALUES (?, ?)", [3, 1]);

  // Olga (id=4) - not enrolled in any course

  console.log('\n🎓 Enrollments:');
  console.log('   • Мария: Основы груминга, Стрижка пуделей');
  console.log('   • Алексей: Основы груминга');
  console.log('   • Ольга: Стрижка пуделей (info step open)');

  // Step progress for users
  //
  // Maria (id=2) - Course 1 "Основы груминга":
  //   Step 1 (info) - completed
  //   Step 2 (task) - rejected with comment
  //   Step 3, 4 - locked
  db.run("INSERT INTO step_progress (user_id, step_id, status) VALUES (?, ?, 'completed')", [2, 1]);
  db.run("INSERT INTO step_progress (user_id, step_id, status, text_answer, admin_comment, submitted_at, reviewed_at) VALUES (?, ?, 'rejected', ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)",
    [2, 2, 'У меня есть расчёска и ножницы', 'Мария, пожалуйста, расскажите подробнее — какого типа расчёска? Есть ли пуходёрка? Также укажите, какие ножницы (прямые, филировочные).']);

  // Maria (id=2) - Course 2 "Стрижка пуделей":
  //   Step 5 (info) - completed
  //   Step 6 (task) - pending (на проверке)
  //   Step 7 - locked
  db.run("INSERT INTO step_progress (user_id, step_id, status) VALUES (?, ?, 'completed')", [2, 5]);
  db.run("INSERT INTO step_progress (user_id, step_id, status, text_answer, submitted_at) VALUES (?, ?, 'pending', ?, CURRENT_TIMESTAMP)",
    [2, 6, 'Основные этапы стрижки "Лев":\n1. Стрижка морды и лап наголо\n2. Формирование гривы на груди и голове\n3. Помпоны на лапах и хвосте\n4. Выравнивание шерсти на корпусе']);

  // Alex (id=3) - Course 1 "Основы груминга":
  //   Step 1 (info) - completed
  //   Step 2 (task) - completed
  //   Step 3 (task) - open
  //   Step 4 - locked
  db.run("INSERT INTO step_progress (user_id, step_id, status) VALUES (?, ?, 'completed')", [3, 1]);
  db.run("INSERT INTO step_progress (user_id, step_id, status, text_answer, submitted_at, reviewed_at) VALUES (?, ?, 'completed', ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)",
    [3, 2, 'У меня есть: пуходёрка металлическая, колтунорез, ножницы прямые 7 дюймов, машинка Moser. Нет филировочных ножниц и фена — планирую купить.']);
  db.run("INSERT INTO step_progress (user_id, step_id, status) VALUES (?, ?, 'open')", [3, 3]);

  // Olga (id=4) - Course 2 "Стрижка пуделей":
  //   Step 5 (info) - open (не просмотрен)
  //   Step 6, 7 - locked
  // Добавляем запись на курс
  db.run("INSERT INTO enrollments (user_id, course_id) VALUES (?, ?)", [4, 2]);
  db.run("INSERT INTO step_progress (user_id, step_id, status) VALUES (?, ?, 'open')", [4, 5]);

  // Save database
  const data = db.export();
  const buffer = Buffer.from(data);
  fs.writeFileSync(DB_FILE, buffer);

  console.log('\n✅ Seed completed! Database saved to', DB_FILE);
}

seed().catch(console.error);
