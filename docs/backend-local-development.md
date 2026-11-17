# Backend-ի լոկալ աշխատանքի ուղեցույց (macOS, zsh)

Այս ուղեցույցը բացատրում է, թե ինչպես ինքնուրույն **գործարկել, ստուգել և կանգնեցնել** Nelio-ի backend-ը քո Mac-ում։
Բոլոր հրամանները վերցված են ռեպոզիտորիայի իրական կոնֆիգուրացիայից (`docker-compose.yml`, `apps/backend/package.json`, `.env.example`, `prisma.config.ts`)։

> **Երկու թղթապանակ, որոնք պետք է չշփոթել**
>
> | Անուն | Ուղի | Ինչի համար |
> |---|---|---|
> | **Ռեպոյի արմատ** | `~/Desktop/Nelio` | Docker (`docker compose …`), `.env` ֆայլը |
> | **Backend** | `~/Desktop/Nelio/apps/backend` | `npm …` հրամանները, Prisma |
>
> Յուրաքանչյուր բլոկի վերևում նշված է, թե որտեղ է այն աշխատեցվում։

---

## 0. Հիշելու համար (սովորական օրը)

**Գործարկում** (երեք տերմինալային հրաման).

```zsh
# 1) Ռեպոյի արմատ
cd ~/Desktop/Nelio
docker compose up -d

# 2) Backend
cd ~/Desktop/Nelio/apps/backend
npm run start
```

Backend-ը աշխատում է այդ տերմինալի մեջ (լոգերը երևում են այնտեղ)։ Ստուգում՝ **նոր** տերմինալում՝ `curl http://localhost:3000/health`, Swagger՝ http://localhost:3000/api/docs

**Կանգնեցում**

```zsh
# Backend-ի տերմինալում՝ սեղմիր  Ctrl + C
# Docker-ը (ըստ ցանկության, տվյալները պահպանվում են)՝
cd ~/Desktop/Nelio
docker compose stop
```

---

## 1. Նախապայմաններ

| Ինչ | Ինչու | Ստուգում |
|---|---|---|
| **Docker Desktop** (բացված և աշխատող) | PostgreSQL 18.6 և Mailpit կոնտեյներների համար | `docker info` պետք է տպի տեղեկություն առանց սխալի |
| **Node.js 22 կամ ավելի նոր** | `npm run start`-ը օգտագործում է `--env-file-if-exists`, որը պահանջում է Node 22 | `node -v` (այս պահին՝ v22.x) |
| **`.env` ֆայլը ռեպոյի արմատում** | JWT գաղտնաբառ, տվյալների բազայի մուտքի տվյալներ | `ls -la ~/Desktop/Nelio/.env` |
| Տեղադրված փաթեթներ | `node_modules` | `ls ~/Desktop/Nelio/apps/backend/node_modules \| head -1` |

**`.env`-ը գաղտնի է.** այն git-ում չէ (`.gitignore`-ում է) և **երբեք չպետք է ուղարկվի** GitHub կամ կպցվի զրույցներում։ Նմուշը `.env.example`-ն է (այն գաղտնի արժեքներ չի պարունակում)։

Ինչ փոփոխականներ պետք են ամենաքիչը (ըստ `.env.example`-ի).

- `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB` – Docker Compose-ը և backend-ը կարդում են դրանք. `DATABASE_URL` պետք չէ, այն ինքնաբերաբար կազմվում է (`localhost:5433`)։
- `JWT_SECRET` – **պարտադիր**, առնվազն 32 բայթ։ Առանց դրա backend-ը չի գործարկվի։

Ստուգել, թե `.env`-ում **որ անուններն** են սահմանված, առանց արժեքները տպելու (տպում է միայն անունները).

```zsh
# Ռեպոյի արմատ
cd ~/Desktop/Nelio
cut -d= -f1 .env | grep -E '^[A-Z_]+$'
```

---

## 2. Docker ծառայությունների գործարկում

**Որտեղ՝ ռեպոյի արմատ** (`~/Desktop/Nelio`), որովհետև այնտեղ է `docker-compose.yml`-ը։

```zsh
cd ~/Desktop/Nelio

# Գործարկում է միայն այս նախագծի երկու ծառայությունները (postgres, mailpit) ֆոնային ռեժիմում.
# Եթե արդեն աշխատում են, ոչինչ չի փոխվում։
docker compose up -d

# Վիճակը. պետք է երկուսն էլ լինեն "Up ... (healthy)" (postgres-ը՝ մոտ 10-20 վրկ հետո)
docker compose ps
```

Ինչ են ծառայությունները.

| Ծառայություն | Պորտ քո Mac-ում | Նշանակություն |
|---|---|---|
| `postgres` (PostgreSQL 18.6) | **5433** | Տվյալների բազա. տվյալները պահվում են `postgres_data` volume-ում և **պահպանվում են** վերագործարկումից հետո |
| `mailpit` | 1025 (SMTP), **8025** (վեբ) | Տեղական փոստարկղ. backend-ի ուղարկած նամակները երևում են http://localhost:8025 |

---

## 3. Միգրացիաների կարգավիճակը՝ անվտանգ ստուգում

**Որտեղ՝ `apps/backend`.** Այս հրամանը **միայն կարդում է** (ոչինչ չի փոխում)։

```zsh
cd ~/Desktop/Nelio/apps/backend
node --env-file-if-exists=../../.env ./node_modules/prisma/build/index.js migrate status
```

- `Database schema is up to date!` – ամեն ինչ կարգին է, ոչինչ անելու կարիք չկա։
- Եթե գրված է, որ կան **չկիրառված (not yet applied) միգրացիաներ** – **կանգ առ**։ Այդ դեպքում միգրացիաները կիրառելը (`npm run db:migrate:deploy`) փոխում է տվյալների բազան. արա դա միայն գիտակցված, և ոչ հենց սկզբից։

> Այս ուղեցույցի հրամաններից ոչ մեկը չի կիրառում միգրացիաներ, չի ստեղծում admin և չի փոխում տվյալները։

---

## 4. Backend-ի գործարկում

**Որտեղ՝ `apps/backend`.**

```zsh
cd ~/Desktop/Nelio/apps/backend

# Սովորական գործարկում. կոմպիլացնում է (nest build) և սկսում է աշխատել։ Տերմինալը «զբաղված» է մնում։
npm run start
```

Ճիշտ գործարկման նշան՝ տերմինալում սկսում են հայտնվել JSON տողեր (`"level":"info"`…) և ոչ մի `Invalid configuration` կամ `Error`։

Այլընտրանք՝ **զարգացման ռեժիմ**, որը ինքնաբերաբար վերագործարկվում է կոդը փոխելիս.

```zsh
npm run start:dev
```

Ուրիշ պորտով (եթե 3000-ը զբաղված է).

```zsh
PORT=3001 npm run start
```

(Այդ դեպքում ստորև բոլոր `3000`-երը փոխարինիր `3001`-ով։)

---

## 5. Ստուգում՝ /health և Swagger

Բաց **նոր տերմինալ** (backend-ի տերմինալը չփակես)։

```zsh
# Առողջության ստուգում. սպասվող պատասխան՝ {"status":"ok","database":"up"}
curl http://localhost:3000/health

# Swagger UI-ը բացում է բրաուզերում
open http://localhost:3000/api/docs

# Նույն փաստաթուղթը JSON-ով (այն, ինչ ստանում է frontend-ը)
curl -s http://localhost:3000/api/docs-json | head -c 200

# API-ի օրինակ. կատեգորիաների ցանկ (բաց է, առանց մուտքի) → 200
curl -i http://localhost:3000/api/v1/categories
```

Նշումներ.

- `/health`-ը **առանց** `/api/v1` նախածանցի է. իսկ ամբողջ մնացած API-ը `/api/v1/…` է։
- Swagger-ը աշխատում է միայն ոչ-production ռեժիմում (լոկալում միշտ միացված է)։
- Եթե `/health`-ը տալիս է `503`, backend-ը աշխատում է, բայց չի հասնում տվյալների բազային (տես՝ «Խնդիրներ»)։
- Պաշտպանված հասցեները առանց տոկենի տալիս են `401`. դա նորմալ է (օր.՝ `curl -i http://localhost:3000/api/v1/me`)։

---

## 6. Կանգնեցում

### Backend

Եթե backend-ը աշխատում է քո տերմինալում.

```zsh
# Սեղմիր  Ctrl + C  այդ տերմինալում
```

Եթե փակել ես տերմինալը կամ չես գտնում այն, պրոցեսը գտիր ըստ պորտի և կանգնեցրու.

```zsh
# Ցույց է տալիս, թե ով է լսում 3000 պորտը (PID-ը երկրորդ սյունակում է)
lsof -nP -iTCP:3000 -sTCP:LISTEN

# Կանգնեցնում է հենց այդ պրոցեսը (SIGTERM, մաքուր դադարեցում).
kill $(lsof -nP -iTCP:3000 -sTCP:LISTEN -t)
```

Ստուգում՝ `lsof -nP -iTCP:3000 -sTCP:LISTEN` հիմա ոչինչ չպետք է տպի։

### Docker ծառայություններ (պարտադիր չէ)

Եթե ուզում ես կանգնեցնել տվյալների բազան և Mailpit-ը (օր.՝ ռեսուրս խնայելու համար).

```zsh
cd ~/Desktop/Nelio
docker compose stop
```

- `docker compose stop` – կանգնեցնում է **միայն այս նախագծի** կոնտեյներները. **տվյալները մնում են**։
- Նորից միացնելու համար՝ `docker compose up -d`։

> **Վտանգավոր՝ մի՛ արա.** `docker compose down -v` (կամ `docker volume rm …`) **ջնջում է տվյալների բազայի volume-ը**՝ բոլոր տվյալներով։ `docker system prune`-ը և այլ նախագծերի կոնտեյներները նույնպես մի՛ դիպչիր։

---

## 7. Խնդիրների լուծում

### 7.1 Պորտ 3000-ը զբաղված է (`EADDRINUSE`)

Նշան՝ `Error: listen EADDRINUSE: address already in use :::3000`։ Սովորաբար մոռացված հին backend-ն է։

```zsh
lsof -nP -iTCP:3000 -sTCP:LISTEN          # տեսնել՝ ով է
kill $(lsof -nP -iTCP:3000 -sTCP:LISTEN -t)   # կանգնեցնել (եթե դա քո հին backend-ն է)
npm run start                              # նորից գործարկել (apps/backend)
```

Կամ աշխատիր այլ պորտով՝ `PORT=3001 npm run start`։ Եթե 3000-ը զբաղեցրել է **քո չճանաչած** ծրագիր, նախ նայիր `lsof`-ի առաջին սյունակը (ծրագրի անունը) և այն մի՛ կանգնեցրու կույր։

### 7.2 Docker-ը կամ տվյալների բազան հասանելի չէ

Նշաններ՝ `/health` → `503`; գործարկման ժամանակ միացման սխալ; `Cannot connect to the Docker daemon`։

```zsh
docker info                      # Docker Desktop-ը աշխատո՞ւմ է։ Եթե սխալ՝ բացիր Docker Desktop-ը և սպասիր
cd ~/Desktop/Nelio
docker compose ps                # postgres-ը "Up (healthy)" է՞
docker compose up -d             # եթե կանգնած է՝ միացնում է
docker compose logs --tail 30 postgres   # postgres-ի վերջին լոգերը
lsof -nP -iTCP:5433 -sTCP:LISTEN         # 5433 պորտը լսո՞ղ է
```

Եթե postgres-ը աշխատում է, բայց backend-ը «authentication failed» է գրում՝ `.env`-ում `POSTGRES_PASSWORD`-ը չի համապատասխանում այն գաղտնաբառին, որով բազան ստեղծվել էր (volume-ը գաղտնաբառը պահում է առաջին ստեղծումից, և `.env`-ը փոխելը այն չի փոխում)։ Ոչինչ մի՛ ջնջիր. նախ վերականգնիր `.env`-ի հին արժեքը։

### 7.3 Բացակայող կամ սխալ միջավայրի փոփոխականներ

Նշան՝ backend-ը անմիջապես փակվում է հաղորդագրությամբ.

```
Invalid configuration (the application will not start):
 - JWT_SECRET is required
```

Հաղորդագրությունը թվարկում է **բոլոր** խնդիրները՝ **միայն անուններով**, արժեքներ չի ցույց տալիս։ Լուծում՝ ավելացրու/ուղղիր այդ փոփոխականը `~/Desktop/Nelio/.env` ֆայլում (ռեպոյի արմատ)։ Օրինակ `JWT_SECRET`-ի համար ստեղծիր պատահական արժեք և ինքդ գրիր `.env`-ի մեջ.

```zsh
openssl rand -base64 48      # տպում է նոր գաղտնաբառ. պատճենիր այն .env-ի  JWT_SECRET=...  տողում
```

(Այս արժեքը ոչ մեկին մի՛ ցույց տուր և git մի՛ ավելացրու։) Այնուհետև նորից `npm run start`։

### 7.4 Prisma Client-ը գեներացված չէ

Նշաններ՝ `Cannot find module '…/src/generated/prisma/client.js'` կամ նմանատիպ սխալ՝ `npm install`/`npm ci`-ից կամ `git pull`-ից հետո։ Գեներացված կոդը git-ում չէ, այն պետք է ստեղծել.

```zsh
# apps/backend
cd ~/Desktop/Nelio/apps/backend
npm run prisma:generate
```

Եթե կասկածում ես փաթեթներին (օր.՝ `git pull`-ից հետո `package-lock.json` է փոխվել)՝

```zsh
npm ci                 # վերատեղադրում է փաթեթները ճիշտ ըստ package-lock.json-ի
npm run prisma:generate
```

### 7.5 Այլ

- `node: bad option: --env-file-if-exists` → Node-ը հին է. պետք է 22+ (`node -v`)։
- `npm run start` շատ դանդաղ կամ «սառած» է → սպասիր ~10-20 վրկ (կոմպիլացիա), հետո նայիր լոգերին։
- Նամակներ չեն գալիս → նայիր http://localhost:8025 (Mailpit) և `docker compose ps`-ում mailpit-ը։

---

## 8. Mac-ի վերագործարկումից հետո

Docker կոնտեյներները նոր մեկնարկից հետո ինքնաբերաբար չեն մեկնարկում, իսկ backend-ը չի աշխատում։ **Տվյալները չեն կորել**՝ դրանք volume-ում են։

1. Բացիր **Docker Desktop** և սպասիր, մինչև այն ասի «running» (մոտ րոպե)։
2. Ռեպոյի արմատից՝

   ```zsh
   cd ~/Desktop/Nelio
   docker compose up -d
   docker compose ps          # սպասիր, մինչև երկուսն էլ "Up … (healthy)" լինեն
   ```

3. Backend-ը՝

   ```zsh
   cd ~/Desktop/Nelio/apps/backend
   npm run start
   ```

4. Ստուգում՝ նոր տերմինալում `curl http://localhost:3000/health` → `{"status":"ok","database":"up"}`, հետո բացիր http://localhost:3000/api/docs

`npm ci`, `npm run prisma:generate` և միգրացիաների ստուգում **պետք չեն** սովորական վերագործարկումից հետո. դրանք պետք են միայն կոդը թարմացնելուց (`git pull`) հետո (տես՝ 7.4 և 3)։

---

## 9. Ինչ չանել (անվտանգության կանոններ)

- `.env`-ը չպատճենել, չուղարկել, չկպցնել զրույցում, չավելացնել git-ում։
- Առանց հստակ պատճառի չկատարել `npm run db:migrate:deploy`, `npm run seed:admin`, `docker compose down -v`։
- Չկանգնեցնել և չջնջել Docker-ի այլ կոնտեյներներ կամ volume-ներ (`docker rm`, `docker volume rm`, `docker system prune`)։
- Production-ում ոչինչ չգործարկել այս ուղեցույցով. այն միայն լոկալ աշխատանքի համար է (production-ի ընթացակարգը՝ `docs/release.md`)։
