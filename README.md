# Job Log

A to-do list that keeps a dated log of finished jobs. One list, synced between an Android app and a desktop web app through Firebase.

- **To do:** add jobs, mark them Urgent, set a due time (your phone reminds you), edit or delete.
- **Done log:** ticked jobs are stamped with the time and grouped by day.
- **Offline:** works without internet and syncs when you reconnect.

## Get the app
- **Android:** open the repo's **Releases** page on your phone, download `JobLog.apk`, and open it to install. Allow "install unknown apps" for your browser if asked.
- **Desktop:** `https://<your-username>.github.io/job-log/`

Every push to `main` rebuilds both.

## First run (each device)
1. Paste your Firebase `firebaseConfig` block and tap **Connect**. To skip this step everywhere, put the config in `www/config.js` instead.
2. On the first device tap **Create account**. On every other device, **Sign in** with the same email and password.

## Firebase rules
```
rules_version = '2';
service cloud.firestore {
  match /databases/{db}/documents {
    match /users/{uid}/{doc=**} {
      allow read, write: if request.auth != null && request.auth.uid == uid;
    }
  }
}
```
