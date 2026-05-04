# צ׳קליסט פריסה למערכת

## מה כבר מוכן בקוד

- שרת production שמגיש גם API וגם Frontend.
- פקודת build:
  `npm run build`
- פקודת start:
  `npm run start`
- health check:
  `/api/health`
- קובץ Render Blueprint:
  `render.yaml`
- Google Drive OAuth בצד לקוח.
- OpenAI API בצד שרת בלבד.
- חלוקת אודיו למקטעים עם ffmpeg.

## מה צריך מהמשתמש כדי להשלים פריסה

### 1. GitHub

צריך repository ב-GitHub.

מה צריך ממך:

- לפתוח GitHub אם אין.
- ליצור repository חדש.
- לתת לי גישה או להעלות את הקוד לשם.

### 2. Render

צריך חשבון Render.

מה צריך ממך:

- להיכנס ל-Render.
- לחבר את GitHub.
- לבחור את repository של הפרויקט.
- להשתמש ב-Blueprint אם Render מזהה את `render.yaml`, או ליצור Web Service ידנית.

### 3. משתני סביבה ב-Render

צריך להכניס ב-Render:

```env
OPENAI_API_KEY=המפתח של OpenAI
VITE_GOOGLE_CLIENT_ID=ה-Client ID של Google
OPENAI_TRANSCRIBE_MODEL=gpt-4o-mini-transcribe
OPENAI_SUMMARY_MODEL=gpt-4.1-mini
OPENAI_CHAT_MODEL=gpt-4.1-mini
OPENAI_RETRY_ATTEMPTS=3
AUDIO_CHUNK_SECONDS=240
```

לא לשלוח את `OPENAI_API_KEY` בצ׳אט. להכניס אותו רק ב-Render.

### 4. Google OAuth אחרי קבלת כתובת האתר

אחרי Render ייתן כתובת כמו:

```text
https://therapy-session-reports.onrender.com
```

צריך להוסיף אותה ב-Google Cloud:

```text
Authorized JavaScript origins:
https://therapy-session-reports.onrender.com
```

### 5. Test users

ב-Google Auth Platform צריך לוודא ששני המשתמשים נמצאים ב-Test users:

- המייל שלך
- המייל של הקולגה

## בדיקת קבלה אחרי פריסה

1. לפתוח את כתובת Render מהמחשב.
2. להתחבר עם Google.
3. לראות `Drive מחובר`.
4. ליצור מטופל בדיקה.
5. להעלות אודיו קצר.
6. להפיק דוח.
7. לשמור.
8. לייצא Word.
9. לבדוק ב-Google Drive שנוצר:
   `Therapy Session Reports`
10. לפתוח את אותה כתובת מהטלפון.
11. להתחבר עם Google.
12. לוודא שרואים את אותם נתונים.
13. להוסיף למסך הבית בטלפון.

