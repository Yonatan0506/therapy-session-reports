# מעבר ל-Google Cloud Run + Cloud Storage

המסמך הזה מתאר את ההתאמה שנוספה למערכת כדי להפוך עיבוד של פגישות ארוכות ליציב יותר.

## מה השתנה בקוד

כאשר מוגדרים משתני Cloud Storage, השרת עובד במודל עמיד יותר:

1. האפליקציה מעלה את האודיו לשרת בצ'אנקים.
2. השרת שומר את האודיו ב-Cloud Storage תחת `audio/...`.
3. השרת שומר סטטוס עבודה ב-Cloud Storage תחת `jobs/{jobId}.json`.
4. העיבוד יכול להמשיך לפי `jobId`, גם אם polling מהטלפון נקטע.
5. אם השרת הופעל מחדש והמשתמש חוזר לבדוק סטטוס, השרת טוען את פרטי העבודה מהענן ומנסה להמשיך.
6. אחרי הצלחה, האודיו הזמני נמחק מ-Cloud Storage כברירת מחדל.

אם Cloud Storage לא מוגדר, המערכת ממשיכה לעבוד כמו קודם.

## שירותי Google Cloud דרושים

- Cloud Run
- Cloud Storage
- Secret Manager או Environment Variables
- Artifact Registry או פריסה ישירה מקוד

בשלב הבא, לשיפור נוסף, כדאי להוסיף:

- Firestore לשמירת סטטוס עבודות במקום קובצי JSON.
- Cloud Tasks או Cloud Run Jobs להפעלת worker נפרד.
- WorkManager/Foreground Service באנדרואיד להעלאה ברקע גם כשהמסך כבוי.

## משתני סביבה חדשים

```env
GCS_BUCKET=therapy-session-audio-temp
GOOGLE_CLOUD_CLIENT_EMAIL=service-account@project-id.iam.gserviceaccount.com
GOOGLE_CLOUD_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n"
DELETE_CLOUD_AUDIO_AFTER_SUCCESS=true
PROCESSING_MODE=hybrid
PROCESSING_WORKER_TOKEN=replace-with-a-long-random-token
```

יש להשאיר גם את המשתנים הקיימים:

```env
OPENAI_API_KEY=...
OPENAI_TRANSCRIBE_MODEL=gpt-4o-mini-transcribe
OPENAI_SUMMARY_MODEL=gpt-4.1-mini
OPENAI_CHAT_MODEL=gpt-4.1-mini
VITE_GOOGLE_CLIENT_ID=...
```

## הרשאות

ל-Service Account של השרת צריך לתת הרשאה על ה-bucket בלבד:

- `Storage Object Admin`

לא צריך לתת לו גישה ל-Google Drive של המטפלים. השמירה ל-Drive ממשיכה להיעשות דרך הרשאת המשתמש.

## הגדרת bucket

שם מומלץ:

```text
therapy-session-audio-temp
```

הגדרות מומלצות:

- Public access prevention: enabled
- Uniform bucket-level access: enabled
- Location: עדיף `europe-west1` או אזור קרוב לישראל/אירופה
- Lifecycle rule: מחיקת objects אחרי 7 ימים

ה-lifecycle חשוב כי אם עיבוד נכשל, האודיו הזמני נשאר לזמן מוגבל כדי לאפשר ניסיון חוזר, ואז נמחק לבד.

## פריסה ל-Cloud Run

הוספתי `Dockerfile` שמתאים ל-Cloud Run.

הגדרות מומלצות לשירות:

- Memory: לפחות `2Gi`
- CPU: לפחות `1`
- Request timeout: `3600s`
- Concurrency: `1` או `2` להתחלה
- Minimum instances: `0` כדי לחסוך כסף, או `1` אם רוצים פחות cold start

הערה: גם אם Cloud Run מאפשר timeout עד 60 דקות, לא כדאי לסמוך על בקשת משתמש אחת ארוכה. לכן הקוד שומר אודיו וסטטוס בענן.

## מצב Worker

נוסף endpoint פנימי:

```text
POST /api/internal/process-job
```

הגוף:

```json
{
  "jobId": "..."
}
```

אם מוגדר `PROCESSING_WORKER_TOKEN`, צריך לשלוח אחד מאלה:

```text
x-worker-token: ...
```

או:

```text
Authorization: Bearer ...
```

בסביבת production חובה להגדיר `PROCESSING_WORKER_TOKEN`; בלי token הקריאה הפנימית תחזיר 401. זה מכוון, כדי שלא יהיה endpoint ציבורי שמפעיל עיבוד.

מצבי עבודה:

- `PROCESSING_MODE=hybrid`  
  ברירת המחדל. השרת יוצר job וגם מנסה לעבד אותו בעצמו. זה המצב המתאים כרגע ל-Render ולבדיקות מעבר.

- `PROCESSING_MODE=inline`  
  כמו hybrid מבחינת העיבוד הנוכחי, מתאים לבדיקה פשוטה.

- `PROCESSING_MODE=worker`  
  השרת רק שומר את האודיו וה-job בענן. הוא לא מפעיל עיבוד בעצמו. במקרה כזה צריך Cloud Tasks, Cloud Run Job, או worker חיצוני שיקרא ל-`/api/internal/process-job`.

המלצה למעבר הדרגתי:

1. להשאיר ב-Render:
   `PROCESSING_MODE=hybrid`
2. לפרוס Cloud Run ראשון גם עם:
   `PROCESSING_MODE=hybrid`
3. אחרי שהכול עובד, להוסיף worker נפרד ולשנות את שירות ה-API ל:
   `PROCESSING_MODE=worker`

## בדיקות קבלה

לפני שימוש אמיתי צריך לבדוק:

1. העלאת קובץ אודיו של 5 דקות.
2. העלאת קובץ אודיו של 30 דקות.
3. העלאת קובץ אודיו של 60 דקות.
4. הקלטה מהאפליקציה באנדרואיד עם מסך פתוח.
5. הקלטה מהאפליקציה באנדרואיד עם מסך כבוי.
6. העלאה ארוכה כשהמסך נשאר פתוח.
7. מעבר לאפליקציה אחרת בזמן שהשרת מעבד.
8. חזרה לאפליקציה אחרי 10 דקות ובדיקה שהדוח מופיע.
9. ניתוק Google Drive לפני שמירה ובדיקה שהעיבוד עצמו לא נופל.
10. בדיקה שהדוח יוצא בעברית בלבד.
11. בדיקה שהאודיו הזמני נמחק מה-bucket אחרי הצלחה.
12. בדיקה שכשיש כשל, מופיע סטטוס ברור ולא דוח טיפולי מזויף.

## שדרוגים שכדאי להוסיף בהמשך

1. **מסך עבודות ממתינות**  
   להציג את כל העבודות: מעלה, ממתין, מעבד, נכשל, הושלם.

2. **המשך העלאה אחרי ניתוק**  
   מעבר ל-resumable upload ישירות ל-Cloud Storage.

3. **עיבוד worker נפרד**  
   הפרדה בין שרת API לבין worker שמבצע תמלול וסיכום.

4. **התראות Android**  
   הודעה כשהדוח מוכן.

5. **לוח עלויות**  
   כמה דקות תומללו החודש וכמה זה עלה.

6. **שמירת אודיו לפי מדיניות**  
   מחיקה אחרי 7/30/90 יום או שמירה קבועה לפי מטפל.

7. **ניסיון חוזר ממקטע שנכשל**  
   אם מקטע 8 מתוך 12 נכשל, לא להתחיל את כל הפגישה מחדש.

8. **Firestore במקום JSON jobs**  
   מתאים יותר לפרודקשן ולכמה משתמשים במקביל.

9. **אימות איכות אוטומטי**  
   בדיקה שהדוח בעברית, שיש CRM, ושאין ניסוח אבחוני נחרץ מדי.

10. **סיכומים תקופתיים מתוזמנים**  
    למשל סיכום חודשי אוטומטי לכל מטופל פעיל.
