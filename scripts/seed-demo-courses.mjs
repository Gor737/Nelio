// Demo data for the Nelio catalog. It only calls the public API (the same calls as in Swagger); it does not touch the backend code.
//
// Run from the repo root while the backend is running:
//   node scripts/seed-demo-courses.mjs
//
// It asks for the Admin and Teacher emails and passwords (or reads ADMIN_EMAIL, ADMIN_PASSWORD, TEACHER_EMAIL,
// TEACHER_PASSWORD from the environment). The Teacher must already be ACTIVE. API_URL defaults to http://localhost:3000/api/v1.
//
// Running it twice creates the courses twice (categories are reused).

import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";

const API_URL = process.env.API_URL ?? "http://localhost:3000/api/v1";
// The backend allows 120 requests per minute per IP; one call every 600 ms stays under it.
const DELAY_MS = 600;

const CATEGORIES = ["Programming", "Design", "Languages", "Business"];

const COURSES = [
  {
    title: "JavaScript from Zero",
    summary: "Learn the basics of JavaScript: variables, functions, arrays and objects, step by step.",
    category: "Programming",
    enrollmentPolicy: "OPEN",
    tags: ["javascript", "beginner", "web"],
  },
  {
    title: "React for Beginners",
    summary: "Build your first React components, work with state and props, and render lists.",
    category: "Programming",
    enrollmentPolicy: "OPEN",
    tags: ["react", "javascript", "frontend"],
  },
  {
    title: "TypeScript in Practice",
    summary: "Types, interfaces and generics explained with small, practical examples.",
    category: "Programming",
    enrollmentPolicy: "APPROVAL_REQUIRED",
    tags: ["typescript", "javascript"],
  },
  {
    title: "UI Design Fundamentals",
    summary: "Spacing, typography, colour and layout: the rules that make an interface look clean.",
    category: "Design",
    enrollmentPolicy: "OPEN",
    tags: ["ui", "design", "beginner"],
  },
  {
    title: "English for Developers",
    summary: "The English you need to read documentation, write commit messages and talk in code reviews.",
    category: "Languages",
    enrollmentPolicy: "APPROVAL_REQUIRED",
    tags: ["english", "communication"],
  },
  {
    title: "Startup Basics",
    summary: "From an idea to the first users: validation, an MVP and simple metrics.",
    category: "Business",
    enrollmentPolicy: "OPEN",
    tags: ["startup", "product"],
  },
];

const SECTIONS = [
  { title: "Getting started", lessons: ["Introduction", "Setting up", "First steps"] },
  { title: "Going further", lessons: ["Core ideas", "Practice", "Summary"] },
];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function api(method, path, { token, body } = {}) {
  for (let attempt = 1; ; attempt++) {
    await sleep(DELAY_MS);
    const res = await fetch(`${API_URL}${path}`, {
      method,
      headers: {
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (res.status === 429 && attempt < 5) {
      const wait = Number(res.headers.get("retry-after") ?? 30) * 1000;
      console.log(`  rate limited, waiting ${wait / 1000}s...`);
      await sleep(wait);
      continue;
    }
    const text = await res.text();
    const data = text ? JSON.parse(text) : null;
    if (!res.ok) {
      const error = new Error(`${method} ${path} -> ${res.status} ${data?.code ?? ""} ${data?.message ?? ""}`);
      error.status = res.status;
      error.data = data;
      throw error;
    }
    return data;
  }
}

async function ask(rl, envName, question) {
  if (process.env[envName]) return process.env[envName];
  return (await rl.question(question)).trim();
}

async function login(email, password) {
  const data = await api("POST", "/auth/login", { body: { email, password } });
  return data.accessToken;
}

async function ensureCategories(adminToken) {
  const existing = await api("GET", "/categories");
  const byName = new Map(existing.map((c) => [c.name.toLowerCase(), c.id]));
  for (const name of CATEGORIES) {
    if (byName.has(name.toLowerCase())) {
      console.log(`Category "${name}" already exists`);
      continue;
    }
    const created = await api("POST", "/admin/categories", { token: adminToken, body: { name } });
    byName.set(name.toLowerCase(), created.id);
    console.log(`Category "${name}" created`);
  }
  return byName;
}

function lessonText(courseTitle, lessonTitle) {
  return `# ${lessonTitle}\n\nThis is a demo lesson of **${courseTitle}**.\n\n- Read the text\n- Try the example\n- Mark the lesson as complete`;
}

async function createCourse(teacherToken, course, categoryId) {
  const created = await api("POST", "/courses", {
    token: teacherToken,
    body: {
      title: course.title,
      summary: course.summary,
      enrollmentPolicy: course.enrollmentPolicy,
      categoryId,
    },
  });
  const courseId = created.id;
  await api("PUT", `/courses/${courseId}/tags`, { token: teacherToken, body: { names: course.tags } });

  for (const section of SECTIONS) {
    const sec = await api("POST", `/courses/${courseId}/sections`, {
      token: teacherToken,
      body: { title: section.title },
    });
    for (const lessonTitle of section.lessons) {
      const lesson = await api("POST", `/courses/${courseId}/sections/${sec.id}/lessons`, {
        token: teacherToken,
        body: { title: lessonTitle },
      });
      await api("POST", `/courses/${courseId}/lessons/${lesson.id}/blocks`, {
        token: teacherToken,
        body: { type: "TEXT", textBody: lessonText(course.title, lessonTitle) },
      });
      await api("POST", `/courses/${courseId}/lessons/${lesson.id}/publish`, { token: teacherToken });
    }
  }

  await api("POST", `/courses/${courseId}/publish`, { token: teacherToken });
  return courseId;
}

async function main() {
  const rl = createInterface({ input: stdin, output: stdout });
  const adminEmail = await ask(rl, "ADMIN_EMAIL", "Admin email: ");
  const adminPassword = await ask(rl, "ADMIN_PASSWORD", "Admin password: ");
  const teacherEmail = await ask(rl, "TEACHER_EMAIL", "Teacher email: ");
  const teacherPassword = await ask(rl, "TEACHER_PASSWORD", "Teacher password: ");
  rl.close();

  console.log(`\nUsing ${API_URL}\n`);
  const adminToken = await login(adminEmail, adminPassword);
  const teacherToken = await login(teacherEmail, teacherPassword);

  const categories = await ensureCategories(adminToken);

  for (const course of COURSES) {
    const categoryId = categories.get(course.category.toLowerCase());
    process.stdout.write(`Course "${course.title}"... `);
    await createCourse(teacherToken, course, categoryId);
    console.log("published");
  }

  const catalog = await api("GET", "/courses");
  console.log(`\nDone. The catalog now has ${catalog.total} course(s).`);
}

main().catch((error) => {
  console.error(`\nFailed: ${error.message}`);
  if (error.data?.errors) console.error(JSON.stringify(error.data.errors, null, 2));
  if (error.status === 403) console.error("Is the Teacher account ACTIVE? Check GET /me/teacher-application.");
  process.exit(1);
});
