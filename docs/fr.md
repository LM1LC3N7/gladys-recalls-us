# Rappels aux États-Unis

Les rappels publiés aux États-Unis, lus dans les données publiques de trois
agences : les produits de consommation de la Consumer Product Safety
Commission (CPSC), les aliments, médicaments et dispositifs médicaux de la
Food and Drug Administration (rapports d’application de la loi d’openFDA),
et les campagnes de rappel de vos véhicules à la National Highway Traffic
Safety Administration (NHTSA), par marque, modèle et année-modèle, ou par
NIV. L’intégration donne à Gladys un appareil à trois valeurs, un
déclencheur de scène pour chaque nouveau rappel de votre sélection, une
action de scène et un widget de tableau de bord.

Elle a été essayée contre les vrais services (30/10/2026) et sur de faux
serveurs bâtis d’après leurs réponses, pas encore sur des semaines d’usage
réel ni avec un vrai Gladys. Aucun appareil chez vous : les données viennent
du cloud.

## Ce que vous obtenez

- Un appareil **Rappels aux États-Unis** avec :
  - **Rappels sur 7 jours** : les rappels de votre sélection dont le jour est
    l’un des 7 derniers (aujourd’hui compris, dans le fuseau de Gladys) : la
    date de rappel de la CPSC, la date de rapport de la FDA (un mercredi, une
    fois par semaine), le jour où la NHTSA a reçu le rapport d’une campagne
    de véhicule.
  - **Campagnes de rappel des véhicules** : les campagnes que la NHTSA liste
    pour vos véhicules, toutes années confondues. Pas de valeur quand aucun
    véhicule n’est suivi.
  - **Dernier rappel** : le plus récent des 7 jours, avec son jour.
- Un déclencheur **États-Unis : nouveau rappel dans ma sélection**, avec le
  titre, le produit, l’entreprise, la catégorie, le motif, le remède, la
  classe FDA, le véhicule, le jour, le lien et un résumé en une phrase comme
  variables. Le déclencheur peut se limiter à certaines catégories
  (véhicules compris).
- Une action de scène **États-Unis : lire les rappels des 7 derniers jours**
  (une phrase à envoyer par message ou à lire à voix haute, le nombre sur 7
  jours, et le nombre de campagnes des véhicules, absent si aucun véhicule
  n’est suivi).
- Un widget **Rappels aux États-Unis** : les rappels des 7 jours, puis les
  dernières campagnes de vos véhicules, les plus graves en rouge (classe I de
  la FDA, ou véhicule que la NHTSA conseille de ne pas conduire ou de garer
  dehors), avec les liens.
- Un bouton **Afficher les rappels des 7 derniers jours** dans la
  configuration.

## Configuration

1. **Catégories** : produits de consommation (CPSC), aliments (FDA),
   médicaments (FDA), dispositifs médicaux (FDA). Les dispositifs médicaux
   ne sont pas suivis par défaut : environ 250 par mois, presque tous du
   matériel hospitalier.
2. **Marques ou mots** (facultatif) : seulement les rappels CPSC et FDA qui
   en citent un dans leur titre, leur produit ou leur entreprise, séparés par
   des virgules. Accents et majuscules indifférents ; un mot ne trouve que
   des mots entiers (« nut » ne trouve pas « peanut »). Les véhicules ne sont
   pas filtrés. Les rappels étant en anglais, les mots aussi.
3. **Véhicules** (facultatif) : `marque, modèle, année` pour chaque véhicule,
   séparés par des points-virgules, par ex. `Honda, Civic, 2019; Ford,
F-150, 2021`, écrits comme la NHTSA les écrit
   ([nhtsa.gov/recalls](https://www.nhtsa.gov/recalls) les liste). Un
   véhicule que la NHTSA ne connaît pas n’a aucune campagne : le statut
   demande alors de vérifier l’orthographe.
4. **NIV** (facultatif) : jusqu’à 3 NIV (VIN, 17 caractères), séparés par des
   virgules, au lieu de saisir les véhicules. Cinq véhicules en tout.
5. **Fréquence de vérification** : 3, 6 (par défaut), 12 ou 24 heures.
6. **Langue des textes** : anglais ou français : les noms des
   fonctionnalités à leur création et les textes envoyés aux scènes. Les
   rappels eux-mêmes sont publiés en anglais par les agences.

Enregistrez, puis créez l’appareil dans l’onglet **Découverte**.

## Vos NIV

Un NIV est un champ de type secret : gardé par Gladys dans sa base, jamais
réaffiché, envoyé seulement à la NHTSA (vPIC, `vpic.nhtsa.dot.gov`) pour
connaître la marque, le modèle et l’année-modèle. L’intégration ne l’écrit
jamais dans ses journaux (debug compris), son statut, sa mémoire (`/data`),
les événements de scène, le widget ni les actions : ils disent « NIV 2 » et
la marque, le modèle et l’année. `/data` garde les campagnes sous la marque,
le modèle et l’année, comme pour un véhicule saisi.

Un NIV est décodé quand il est enregistré, à chaque démarrage, puis une fois
par jour. Un démarrage moins de 10 minutes après un décodage (conteneur qui
redémarre en boucle) ne redemande pas vPIC : il reprend la marque, le modèle
et l’année décodés alors, gardés par position dans `/data` (jamais le NIV),
jusqu’à la fin des 10 minutes. Un NIV changé pendant que l’intégration était
arrêtée est donc suivi avec 10 minutes de retard au plus. Les rappels sont alors ceux de la
marque, du modèle et de l’année, **pas** de votre véhicule précis : savoir si
le vôtre a déjà été réparé n’est possible que sur le site de la NHTSA, avec
le NIV ([nhtsa.gov/recalls](https://www.nhtsa.gov/recalls)), qu’aucune
interface publique ne donne.

## Fonctionnement

Chaque source est lue une fois par intervalle, une requête à la fois, à une
seconde d’écart, avec un User-Agent au nom de l’intégration :

- CPSC : les rappels des 21 derniers jours (environ 40 par mois) ;
- openFDA : les rapports des 21 derniers jours, pour chaque catégorie suivie
  (1 000 au plus par requête ; au-delà, le statut dit que certains
  sont ignorés). openFDA répond « non modifié » quand rien n’a changé ; sans
  clé, son quota est de 1 000 requêtes par jour et par adresse, bien
  au-dessus de ce que l’intégration demande ;
- NHTSA : les campagnes de chaque véhicule.

Un rappel est **nouveau** quand son numéro était absent de toutes les
réponses de sa source lues avant. La première réponse d’une source ne
déclenche rien (ce qui y figure alors n’est pas une nouveauté), pas plus
qu’une sélection élargie. Un nouveau rappel CPSC ou FDA dont le jour a plus
de 14 jours est retenu sans déclencher ; une campagne de véhicule déclenche
quel que soit son jour (elle est nouvelle pour votre véhicule). Un événement
de scène refusé par Gladys est renvoyé à la lecture suivante de sa source ;
20 événements au plus partent par vérification, les autres à la suivante,
200 au plus en attente par source (au-delà, les plus anciens sont abandonnés
et le statut le dit). Un événement est envoyé avant que `/data`
l’enregistre : si l’intégration est tuée entre les deux, il est renvoyé
après le redémarrage.

Ce qui a été vu, la copie des rappels récents et l’heure de la dernière
lecture de chaque source sont gardés dans `/data` : un redémarrage ne
redéclenche rien, garde l’heure prévue de la lecture suivante et publie les
copies gardées si elles sont encore fraîches. Une source ajoutée par la
configuration est lue tout de suite ; une source retirée puis remise garde
son heure. Des configurations enregistrées coup sur coup s’appliquent dans
l’ordre : la dernière gagne.

## Statut et pannes

Chaque source est indépendante : une source en échec ou qui demande
d’attendre ne retient pas la lecture des autres (les compteurs, eux,
attendent toutes les sources, voir plus bas). Le statut de l’intégration dit :

- une source est illisible (réseau, erreur HTTP, réponse dans un autre
  format), avec son prochain essai : 15 minutes plus tard, puis 30, doublé
  jusqu’à l’intervalle ; une réponse « 429 » ou « 5xx » met cette agence en
  pause de 1 minute à 6 heures (le `Retry-After` du serveur quand il en
  donne un), gardée au redémarrage ;
- un NIV ne peut pas être décodé, ou ne fait pas 17 caractères valides (par
  sa position) ;
- un véhicule n’est pas compris, ou il y a plus de 5 véhicules ;
- un véhicule n’a aucune campagne connue de la NHTSA (vérifier
  l’orthographe) ;
- openFDA n’a pas chargé de nouveaux rapports depuis 21 jours (comparé à la
  date que donne le serveur) : les compteurs ne sont alors plus publiés
  jusqu’à sa mise à jour ;
- rien n’est suivi ;
- `/data` est illisible, ne peut pas être écrit ou ne répond pas (les lectures
  continuent) ;
- plus de 200 nouveaux rappels d’une source attendent Gladys (les plus anciens
  abandonnés).

## À jour ou non

Les rappels sont **à jour** quand chaque source suivie a été lue avec succès
il y a moins de deux intervalles et une heure, et qu’openFDA n’est pas
périmé. Sinon :

- les compteurs de l’appareil ne sont pas publiés (ils gardent leur dernière
  valeur) : jamais un nombre qui oublie une source, jamais 0 pour ce qui est
  inconnu ;
- l’action de scène échoue avec la raison (« Les rappels ne sont pas à jour :
  CPSC (produits de consommation) lu pour la dernière fois le … », « Pas
  encore lu : FDA (aliments). », « Rien n’est suivi »), pour qu’une scène ne
  lise jamais « aucun rappel » sur des données qui ne sont pas à jour ;
- le bouton de configuration donne cette raison au lieu des rappels ;
- le widget titre « Rappels non à jour » (ou « En attente des sources »,
  « Rien n’est suivi ») et liste les rappels des sources qui le sont.

Quand la dernière lecture d’une source a échoué mais que ses rappels sont
encore à jour, l’action de scène, le bouton et le widget les donnent avec un
avertissement en tête (« Attention : la dernière lecture a échoué pour CPSC
(produits de consommation) (… ; rappels du …). »).

## Limites

- Un complément, pas un système d’alerte officiel : vérifiez toujours la
  fiche de rappel. Non affiliée à la CPSC, la FDA, la NHTSA ni à aucune
  agence américaine.
- openFDA : « Do not rely on openFDA to make decisions regarding medical
  care » ; ses rapports arrivent une fois par semaine, avec quelques jours de
  retard, et ne contiennent pas tous les rappels de la semaine (certains
  arrivent plus tard). Les rapports de la FDA n’ont pas de lien propre : le
  lien mène à la page des rappels de la FDA.
- Les campagnes d’un véhicule sont celles d’une marque, d’un modèle et d’une
  année, pas de votre véhicule.

## Données et licence

Rappels de la CPSC (saferproducts.gov), openFDA (api.fda.gov) et NHTSA
(api.nhtsa.gov, vpic.nhtsa.dot.gov) : données publiques du gouvernement des
États-Unis, lues sans compte ni clé. Voir
[open.fda.gov/license](https://open.fda.gov/license/).
