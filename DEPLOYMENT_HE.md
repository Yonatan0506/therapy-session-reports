# פריסה כדי להשתמש במערכת מהנייד ומהמחשב

כרגע המערכת רצה מקומית בכתובת:

`http://127.0.0.1:5173`

הכתובת הזאת עובדת רק במחשב שלך. כדי שהקולגה תוכל להתחבר מהמחשב ומהנייד שלה, צריך לפרוס את המערכת לכתובת HTTPS ציבורית.

## מה הפריסה צריכה לספק

- כתובת HTTPS, למשל:
  `https://therapy-session-reports.onrender.com`
- שרת Node שמריץ את ה-API.
- Frontend React שמוגש מאותו שרת.
- משתני סביבה:
  - `OPENAI_API_KEY`
  - `OPENAI_TRANSCRIBE_MODEL`
  - `OPENAI_SUMMARY_MODEL`
  - `OPENAI_CHAT_MODEL`
  - `VITE_GOOGLE_CLIENT_ID`

## אפשרות מומלצת ופשוטה: Render

הפרויקט כבר כולל קובץ:

`render.yaml`

אם משתמשים ב-Render Blueprint, Render יכול לקרוא ממנו את רוב הגדרות הפריסה לבד.

### שלב 1: להעלות את הקוד ל-GitHub

1. פותחים חשבון GitHub אם אין.
2. יוצרים repository חדש.
3. מעלים אליו את תיקיית הפרויקט.
4. לא מעלים את הקובץ `.env`.

הקובץ `.gitignore` כבר מונע העלאה של `.env`.

### שלב 2: ליצור Web Service ב-Render

1. נכנסים ל:
   https://render.com/
2. מתחברים עם GitHub.
3. לוחצים:
   `New`
4. בוחרים:
   `Web Service`
5. בוחרים את ה-repository של הפרויקט.

### שלב 3: הגדרות Build ו-Start

ב-Render מגדירים:

Build Command:

```bash
npm install && npm run build
```

Start Command:

```bash
npm run start
```

### שלב 4: Environment Variables

ב-Render מוסיפים:

```env
OPENAI_API_KEY=המפתח של OpenAI
OPENAI_TRANSCRIBE_MODEL=gpt-4o-mini-transcribe
OPENAI_SUMMARY_MODEL=gpt-4.1-mini
OPENAI_CHAT_MODEL=gpt-4.1-mini
VITE_GOOGLE_CLIENT_ID=ה-Client ID של Google
OPENAI_RETRY_ATTEMPTS=3
AUDIO_CHUNK_SECONDS=240
```

לא צריך להגדיר `PORT`; Render מגדיר אותו לבד.

### שלב 5: Deploy

1. לוחצים Deploy.
2. מחכים שה-build יסתיים.
3. מקבלים URL ציבורי עם HTTPS.

לדוגמה:

`https://therapy-session-reports.onrender.com`

## עדכון Google OAuth אחרי הפריסה

אחרי שיש URL ציבורי:

1. חוזרים ל-Google Cloud Console.
2. נכנסים ל-Google Auth Platform.
3. נכנסים ל-Clients.
4. פותחים את ה-Web client שיצרת.
5. מוסיפים ל-Authorized JavaScript origins את כתובת האתר:

```text
https://your-app-name.onrender.com
```

6. שומרים.

בלי השלב הזה, Google Login יעבוד מקומית אבל לא באתר הציבורי.

## חיבור הקולגה

ב-Google Auth Platform:

1. נכנסים ל-Audience.
2. מוסיפים Test user.
3. מוסיפים את ה-Gmail של הקולגה.

כל עוד האפליקציה במצב Testing, רק Test users יכולים להתחבר.

## בדיקה אחרי פריסה

1. פותחים את כתובת האתר מהמחשב.
2. לוחצים כניסה עם Google.
3. מוודאים שמופיע `Drive מחובר`.
4. יוצרים מטופל בדיקה.
5. מעלים אודיו קצר.
6. מפיקים דוח.
7. לוחצים שמור.
8. בודקים ב-Google Drive שנוצרה תיקיית:
   `Therapy Session Reports`

## התקנה בטלפון

1. פותחים את כתובת האתר בטלפון ב-Chrome.
2. לוחצים על שלוש הנקודות.
3. בוחרים:
   `הוספה למסך הבית`
4. מאשרים.

## הערת הקלטה

הקלטה מתוך האתר תעבוד כשהמסך פתוח. אם נועלים את המסך, Android/Chrome עלולים לעצור את ההקלטה. הקלטה אמינה עם מסך כבוי היא שלב Android wrapper עתידי.
