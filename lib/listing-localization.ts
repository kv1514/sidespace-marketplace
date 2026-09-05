import type { Locale } from "@/lib/i18n";

/**
 * Listing-authored copy is separate from the interface catalog. Titles and
 * descriptions come from members, so they need their own translation record
 * and must never be run through a word-for-word UI lookup.
 *
 * The optional `translations` property is deliberately accepted here even
 * though the current public listing query does not select it yet. It gives
 * future persisted translations one stable shape while the local catalogue
 * below makes the seeded marketplace genuinely useful in every shipped
 * locale today.
 */
export type ListingTranslationFields = Partial<{
  title: string;
  format: string;
  description: string;
  demographics: string;
  deliverables: string;
  availability_notes: string;
  minimum_booking: string;
  cancellation_policy: string;
}>;

export type ListingTranslations = Partial<
  Record<Locale, ListingTranslationFields>
>;

type LocalizableListing = {
  id: string;
  title: string;
  format: string;
  description: string;
  demographics?: string | null;
  deliverables?: string | null;
  availability_notes?: string | null;
  minimum_booking?: string | null;
  cancellation_policy?: string | null;
  translations?: ListingTranslations | null;
};

type DemoTranslation = {
  es: ListingTranslationFields;
  fr: ListingTranslationFields;
  zh: ListingTranslationFields;
};

/**
 * The local fallback catalogue is real product content, not placeholder
 * lorem ipsum. Keeping these translations keyed by the immutable demo id
 * means a title edit cannot accidentally translate an unrelated live row.
 */
export const DEMO_LISTING_TRANSLATIONS: Readonly<
  Record<string, DemoTranslation>
> = {
  "a1111111-1111-4111-8111-111111111111": {
    es: {
      title: "Historia local + destacado guardado",
      format: "3 historias · destacado durante 48 h",
      description:
        "Una recomendación natural de tres historias para una tienda, evento o servicio local, guardada durante 48 horas.",
      demographics: "68 % de 18 a 34 años · zona de Bisbee",
    },
    fr: {
      title: "Story locale + highlight enregistré",
      format: "3 stories · highlight pendant 48 h",
      description:
        "Une recommandation naturelle en trois stories pour une boutique, un événement ou un service local, conservée pendant 48 heures.",
      demographics: "68 % des 18–34 ans · région de Bisbee",
    },
    zh: {
      title: "本地故事 + 已保存精选",
      format: "3 个画面 · 保存 48 小时",
      description:
        "为本地商店、活动或服务制作自然的三画面推荐，并在精选中保留 48 小时。",
      demographics: "68% 为 18–34 岁 · Bisbee 地区",
    },
  },
  "a2222222-2222-4222-8222-222222222222": {
    es: {
      title: "Reseña de comida del oeste de Texas",
      format: "30–45 s · incluye etiqueta de la localidad",
      description:
        "Una reseña útil de comida o de una parada de carretera, grabada en el lugar y publicada cuando la audiencia local está activa.",
      demographics: "61 % de 21 a 39 años · oeste de Texas",
    },
    fr: {
      title: "Découverte gourmande dans l’ouest du Texas",
      format: "30–45 s · nom de la ville inclus",
      description:
        "Une découverte utile d’un restaurant ou d’une halte routière, filmée sur place et publiée quand l’audience locale est active.",
      demographics: "61 % des 21–39 ans · ouest du Texas",
    },
    zh: {
      title: "西德州美食店探访",
      format: "30–45 秒 · 包含城镇标签",
      description:
        "在现场拍摄一条实用的美食或公路停靠点介绍，在本地观众活跃时发布。",
      demographics: "61% 为 21–39 岁 · 西德州",
    },
  },
  "a3333333-3333-4333-8333-333333333333": {
    es: {
      title: "Ruta local en la ventanilla trasera",
      format: "18 × 24 pulg. · resistente a la intemperie",
      description:
        "Espacio publicitario en la ventanilla trasera de un coche clásico que recorre el centro, el mercado y las rutas de reparto locales.",
      demographics: "8,4 mil visualizaciones mensuales · ruta local",
    },
    fr: {
      title: "Itinéraire local sur la vitre arrière",
      format: "18 × 24 po · résistant aux intempéries",
      description:
        "Un emplacement sur la vitre arrière d’un break vintage qui circule entre le centre-ville, le marché et les livraisons locales.",
      demographics: "8,4 k vues mensuelles · itinéraire local",
    },
    zh: {
      title: "后车窗本地路线广告",
      format: "18 × 24 英寸 · 防风雨",
      description:
        "复古旅行车后车窗广告位，往返市中心、集市和本地配送路线。",
      demographics: "每月 8.4K 次曝光 · 本地路线",
    },
  },
  "a4444444-4444-4444-8444-444444444444": {
    es: {
      title: "Escaparate de café + cartel en la acera",
      format: "2 espacios pequeños · prueba semanal",
      description:
        "Un póster tamaño carta en el escaparate y un pequeño panel en la acera entre el campus y el centro.",
      demographics: "6,2 mil visualizaciones semanales · 76 % de 18 a 29 años",
    },
    fr: {
      title: "Vitrine de café + panneau de trottoir",
      format: "2 petits emplacements · preuve hebdomadaire",
      description:
        "Un poster format lettre en vitrine et un petit panneau sur le trottoir entre le campus et le centre-ville.",
      demographics: "6,2 k vues hebdomadaires · 76 % des 18–29 ans",
    },
    zh: {
      title: "咖啡馆橱窗 + 人行道标牌",
      format: "2 个小型展示位 · 每周提供证明照片",
      description:
        "校园与市中心之间，一张信纸大小的橱窗海报和一块小型人行道标牌。",
      demographics: "每周 6.2K 次曝光 · 76% 为 18–29 岁",
    },
  },
  "a5555555-5555-4555-8555-555555555555": {
    es: {
      title: "Socios para el lanzamiento de café local",
      format: "Historia · degustación · tarjeta de mostrador",
      description:
        "Una breve solicitud remunerada para creadores y espacios de mostrador con una conexión real con la cultura del café de la zona de Driftless.",
      demographics: "Estudiantes, familias y visitantes de fin de semana",
    },
    fr: {
      title: "Partenaires pour un lancement café local",
      format: "Story · dégustation · carte de comptoir",
      description:
        "Une courte demande rémunérée pour des créateurs et des comptoirs ayant un lien réel avec la culture café de la région de Driftless.",
      demographics: "Étudiants, familles et visiteurs du week-end",
    },
    zh: {
      title: "本地咖啡发布合作伙伴",
      format: "快拍 · 试饮 · 柜台卡",
      description:
        "面向创作者和柜台展示位的短期付费需求，合作方应与 Driftless 地区的咖啡文化有真实联系。",
      demographics: "大学生、家庭和周末游客",
    },
  },
  "a6666666-6666-4666-8666-666666666666": {
    es: {
      title: "Intercambio de postales de Main Street",
      format: "50 tarjetas · 3 mostradores locales",
      description:
        "Una pequeña promoción cruzada: tu tarjeta junto a nuestros mapas de senderos e impresiones de arte en tres tiendas cercanas.",
      demographics: "Residentes, excursionistas y visitantes de fin de semana",
    },
    fr: {
      title: "Échange de cartes postales sur Main Street",
      format: "50 cartes · 3 comptoirs locaux",
      description:
        "Une petite promotion croisée qui place votre carte à côté de nos cartes de sentiers et tirages d’art dans trois boutiques voisines.",
      demographics: "Habitants, randonneurs et visiteurs du week-end",
    },
    zh: {
      title: "主街明信片互推",
      format: "50 张卡片 · 3 个本地柜台",
      description:
        "把你的卡片放在附近三家商店的路线图和艺术印刷品旁，进行小规模交叉推广。",
      demographics: "本地居民、徒步者和周末游客",
    },
  },
  "a7777777-7777-4777-8777-777777777777": {
    es: {
      title: "Panel en la sombrilla del puesto agrícola",
      format: "Un panel de 12 × 18 pulg.",
      description:
        "Un letrero resistente a la intemperie junto a la mesa de productos, donde los conductores ya reducen la velocidad y se detienen.",
      demographics: "3,6 mil paradas mensuales · familias",
    },
    fr: {
      title: "Panneau sur le parasol du stand fermier",
      format: "Un panneau de 12 × 18 po",
      description:
        "Un panneau résistant aux intempéries près de l’étal de produits, là où les conducteurs ralentissent déjà et s’arrêtent.",
      demographics: "3,6 k arrêts mensuels · familles",
    },
    zh: {
      title: "农场摊位雨伞展示板",
      format: "一块 12 × 18 英寸展示板",
      description:
        "在司机本来就会减速停车的农产品桌旁放置一块耐候标牌。",
      demographics: "每月 3.6K 次停车 · 家庭",
    },
  },
  "a8888888-8888-4888-8888-888888888888": {
    es: {
      title: "Tarjeta en el mostrador de caja",
      format: "Tarjeta de 5 × 7 pulg. · mostrador delantero",
      description:
        "Una tarjeta sencilla que ven los compradores habituales y los visitantes del lago mientras pagan sus compras.",
      demographics: "2,2 mil compradores semanales · todas las edades",
    },
    fr: {
      title: "Carte sur le comptoir de caisse",
      format: "Carte de 5 × 7 po · comptoir d’entrée",
      description:
        "Une carte simple, visible par les habitués et les visiteurs du lac au moment de passer en caisse.",
      demographics: "2,2 k acheteurs hebdomadaires · tous les âges",
    },
    zh: {
      title: "收银台柜台卡",
      format: "5 × 7 英寸卡片 · 前台柜台",
      description:
        "一张简洁的柜台卡，顾客结账时，本地常客和湖区游客都能看到。",
      demographics: "每周 2.2K 名顾客 · 各年龄段",
    },
  },
  "a9999999-9999-4999-8999-999999999999": {
    es: {
      title: "Portatarjetas del banco de espera",
      format: "Tarjeta A6 · espejo + banco de espera",
      description:
        "Un pequeño portatarjetas donde los clientes tienen tiempo para leer sobre un servicio o evento cercano.",
      demographics: "900 visitas mensuales · hogares locales",
    },
    fr: {
      title: "Porte-cartes sur le banc d’attente",
      format: "Carte A6 · miroir + banc d’attente",
      description:
        "Un petit porte-cartes où les clients ont le temps de lire la présentation d’un service ou d’un événement voisin.",
      demographics: "900 visites mensuelles · foyers locaux",
    },
    zh: {
      title: "等候长椅卡片架",
      format: "A6 卡片 · 镜子 + 等候长椅",
      description:
        "小型卡片架，顾客在等候时可以阅读附近服务或活动的信息。",
      demographics: "每月 900 次到访 · 本地家庭",
    },
  },
  "b1111111-1111-4111-8111-111111111111": {
    es: {
      title: "Tarjeta en la ventana de recogida de la panadería",
      format: "Póster tamaño carta · ventana de recogida",
      description:
        "Un póster limpio junto a la vitrina de pasteles para un evento local, una clase, un creador o un servicio familiar.",
      demographics: "1,8 mil visitas semanales · familias",
    },
    fr: {
      title: "Carte à la fenêtre de retrait de la boulangerie",
      format: "Poster format lettre · fenêtre de retrait",
      description:
        "Un poster épuré près de la vitrine des pâtisseries pour un événement local, un cours, un créateur ou un service familial.",
      demographics: "1,8 k visites hebdomadaires · familles",
    },
    zh: {
      title: "面包店取货窗卡片",
      format: "信纸大小海报 · 取货窗口",
      description:
        "在糕点展示柜旁放置一张简洁海报，适合本地活动、课程、手工艺人或家庭友好服务。",
      demographics: "每周 1.8K 次到访 · 家庭",
    },
  },
  "b2222222-2222-4222-8222-222222222222": {
    es: {
      title: "Mención semanal de creadores locales",
      format: "Una recomendación · email + Instagram",
      description:
        "Una recomendación breve en nuestro resumen de creadores locales del viernes, con foto, enlace y etiqueta de la localidad.",
      demographics: "2,4 mil lectores locales · de 25 a 54 años",
    },
    fr: {
      title: "Mention hebdomadaire d’un créateur local",
      format: "Une mise en avant · email + Instagram",
      description:
        "Une recommandation concise dans notre sélection du vendredi, avec photo, lien et nom de la ville.",
      demographics: "2,4 k lecteurs locaux · 25–54 ans",
    },
    zh: {
      title: "每周本地创作者推荐",
      format: "一次专题推荐 · 邮件 + Instagram",
      description:
        "在周五本地创作者汇总中发布简短推荐，附照片、链接和城镇标签。",
      demographics: "2.4K 名本地读者 · 25–54 岁",
    },
  },
  "b3333333-3333-4333-8333-333333333333": {
    es: {
      title: "Tablón del porche + pie de recibo",
      format: "2 espacios pequeños · 2 semanas",
      description:
        "Un espacio en el tablón del porche y un mensaje breve en el recibo para un evento, creador o guía cercana.",
      demographics: "Residentes y visitantes de fin de semana",
    },
    fr: {
      title: "Panneau du porche + pied de reçu",
      format: "2 petits emplacements · 2 semaines",
      description:
        "Un emplacement sur le panneau du porche et un court message sur le reçu pour un événement, un créateur ou un guide voisin.",
      demographics: "Habitants et visiteurs du week-end",
    },
    zh: {
      title: "门廊公告板 + 小票页脚",
      format: "2 个小型展示位 · 2 周",
      description:
        "门廊公告板位置，加上一条面向附近活动、手工艺人或指南的简短小票消息。",
      demographics: "本地居民 + 周末旅行者",
    },
  },
};

function nonEmpty(value: string | null | undefined) {
  return typeof value === "string" && value.trim() ? value : undefined;
}

/**
 * Return the copy a visitor should read. Unknown live listings stay in the
 * owner's original language until a verified translation is supplied; a
 * fallback that silently invents or partially rewrites claims would be less
 * accurate than showing the source.
 */
export function localizedListingCopy(
  listing: LocalizableListing,
  locale: Locale,
  translateListings: boolean,
) {
  const original = {
    title: listing.title,
    format: listing.format,
    description: listing.description,
    demographics: listing.demographics ?? "",
    deliverables: listing.deliverables ?? "",
    availability_notes: listing.availability_notes ?? "",
    minimum_booking: listing.minimum_booking ?? "",
    cancellation_policy: listing.cancellation_policy ?? "",
  };

  if (!translateListings || locale === "en") {
    return { ...original, translated: false };
  }

  const fields = listing.translations?.[locale] ?? DEMO_LISTING_TRANSLATIONS[listing.id]?.[locale];
  if (!fields) return { ...original, translated: false };

  return {
    title: nonEmpty(fields.title) ?? original.title,
    format: nonEmpty(fields.format) ?? original.format,
    description: nonEmpty(fields.description) ?? original.description,
    demographics: nonEmpty(fields.demographics) ?? original.demographics,
    deliverables: nonEmpty(fields.deliverables) ?? original.deliverables,
    availability_notes:
      nonEmpty(fields.availability_notes) ?? original.availability_notes,
    minimum_booking:
      nonEmpty(fields.minimum_booking) ?? original.minimum_booking,
    cancellation_policy:
      nonEmpty(fields.cancellation_policy) ?? original.cancellation_policy,
    translated: true,
  };
}
