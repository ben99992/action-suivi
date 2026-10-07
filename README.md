# Action ! — suivi de l'avancement

Branche autonome `suivi` (sans lien avec le code de l'app), extraite dans `.suivi/` du dépôt principal.

- `taches.json` : tâches et dépendances, reprises des plans (`docs/superpowers/plans/`, sections « Interfaces → Consumes »). Seule partie écrite à la main.
- `sync.mjs` : calcule `progress.json` à partir de `taches.json`, des registres du contrôleur (`.superpowers/sdd/<plan>/progress.md`, fichiers brief/rapport/revue) et de git ; commit puis push si quelque chose a changé. Lancé toutes les 2 minutes par la tâche planifiée Windows « Action suivi ».
- `reference.json` : référence « prévu », figée une fois (cadence observée), pour le prévu vs réalisé.
- `dashboard.html` : visualisation (relit `progress.json` toutes les 30 s).

Statuts : « fait » = ligne `Task N: complete` du registre ; « en cours » = brief écrit sans ligne complete (avancement par étape réelle : 15 % lancé, 60 % livré, 75 % en revue, 80–90 % corrections) ; « bloqué » = ligne BLOCKED ou attente utilisateur déclarée dans `taches.json` ; sinon « à faire ».

Ajouter une tâche (nouveau plan) : l'ajouter dans `taches.json` avec ses dépendances ; le reste est automatique.
