# חיבור Google Sign In ו-Google Drive

המטרה: לאפשר כניסה עם Gmail ושמירת נתוני המערכת ב-Google Drive של המטפל באמצעות הרשאת `drive.file`.

## מה כבר קיים בקוד

- האפליקציה טוענת את Google Identity Services.
- הכניסה מבקשת scopes:
  - `openid`
  - `email`
  - `profile`
  - `https://www.googleapis.com/auth/drive.file`
- אחרי שמירה, האפליקציה מנסה ליצור תיקייה בשם `Therapy Session Reports`.
- האפליקציה שומרת ל-Drive:
  - `patients_index.json`
  - `sessions_index.json`
  - `session_{sessionId}.json`

## מה צריך לעשות ב-Google Cloud

1. היכנס ל-Google Cloud Console:
   https://console.cloud.google.com/

2. צור Project חדש או בחר Project קיים.

3. פתח את Google Auth Platform או APIs & Services.

4. הגדר OAuth consent screen:
   - App name: `Therapy Session Reports`
   - User support email: המייל שלך
   - Audience/User type: לשימוש אישי אפשר להתחיל כ-External במצב Testing
   - Developer contact email: המייל שלך

5. הוסף Test users:
   - המייל שלך
   - המייל של הקולגה

6. Enable APIs:
   - Google Drive API

7. צור OAuth Client:
   - Application type: `Web application`
   - Name: `Therapy Session Reports Local`

8. הוסף Authorized JavaScript origins:
   - `http://127.0.0.1:5173`
   - `http://localhost:5173`

9. צור את ה-client והעתק את ה-Client ID.

10. פתח את קובץ `.env` בתיקיית הפרויקט והוסף:

```env
VITE_GOOGLE_CLIENT_ID=your-client-id.apps.googleusercontent.com
```

11. הפעל מחדש את שרתי הפיתוח:

```powershell
npm.cmd run dev:all
```

12. בדוק באפליקציה:
   - לחץ "כניסה עם Google"
   - אשר הרשאות
   - צור/שמור פגישה
   - בדוק בדרייב שנוצרה תיקיית `Therapy Session Reports`

## הערות חשובות

- אין לשים ב-Frontend את `OPENAI_API_KEY`.
- Google Client ID אינו סוד כמו OpenAI API key, אבל עדיין צריך להגדיר origins נכונים.
- לפריסה אמיתית לנייד צריך URL עם HTTPS ולהוסיף אותו ל-Authorized JavaScript origins.
- הרשאת `drive.file` מצומצמת יותר מהרשאת Drive מלאה ומתאימה לאפליקציה שיוצרת ומנהלת רק קבצים שלה.

