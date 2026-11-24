const films = [
  {
    id: 'platform', title: '越過月臺', english: 'Beyond the Platform', category: '城市', duration: '01:08', format: '三面牆與地板空間模擬',
    cover: 'assets/platform-cover.jpg?v=covers1',
    short: '從高鐵月臺起飛，越過欄杆，沿林蔭大道向遠方飛行。',
    concept: '候車時，欄杆把腳下的月臺和遠方的城市分開。作品讓視線跨過這道邊界。近處的樹冠和屋頂迅速移向腳邊，遠處的天際線幾乎留在原地，飛行的高度從這個落差中顯現。',
    description: '鏡頭從月臺平視起飛，沿街廓上升，最後八秒逐漸減速。站內影片以展間中央的視點呈現三面牆與地板。現場放映時，兩支投影版從 00:00 同步啟動，Suno 配樂由三面牆版播放。',
    youtube: 'https://youtu.be/vOduOw-6l0I',
    projectionLinks: [
      { label: '三面牆投影版（5760 × 1080）', url: 'https://youtu.be/1ZvA17d3A80' },
      { label: '地板投影版（1080 × 1080，無聲）', url: 'https://youtube.com/shorts/0ivTQCWw_GY' }
    ]
  },
  {
    id: 'torii', title: '星渡風之庭・穿越鳥居', english: 'Beyond the Torii', category: '山林', duration: '01:05', format: '三面牆與地板空間模擬',
    short: '在銀河與雲海交會的山巔，穿過一座鳥居。',
    concept: '鳥居標記了山徑上的一道門檻。把它放在雲海與星空之間，觀者先從遠處辨認它的輪廓，再循著石徑靠近，經過同一片風景的遠景與近景。',
    description: '鏡頭自後方展開，逐步帶出山脊、燈籠與鳥居。銀河橫過上方，腳下的石紋則隨行進方向移動。這個版本保留展場視角，可以看見牆面與地板如何接續。'
  },
  {
    id: 'cedar', title: '杉影拾階', english: 'Steps Through the Cedars', category: '山林', duration: '00:24', format: '三面牆與地板空間模擬',
    cover: 'assets/cedar-cover.jpg?v=covers1',
    short: '順著石階向上，從一重鳥居走向下一重。',
    concept: '登階時，目光會在腳下的石紋和前方的路之間來回。作品以一段看得見盡頭、卻還要再走幾步的階梯，呈現山林步道特有的節奏。',
    description: '杉木夾著一列朱紅鳥居，石燈沿階梯排列。正面保留石階的消失點，兩側讓林木從身旁移過，地面投影則接起最近的一級石階。'
  },
  {
    id: 'flight', title: '雲上飛行', english: 'Above the Clouds', category: '天空與宇宙', duration: '00:24', format: '三面牆與地板空間模擬',
    short: '從山稜上方掠過，望向金色的天際線。',
    concept: '飛行的高度需要地景襯托。畫面刻意留出雲層的空隙，讓觀者既看得見遠方的光，也能從掠過腳下的山稜感覺自己正在前進。',
    description: '本頁播放少雲版。暖色天空沿三面牆展開，稜線、谷地與零星雲團延伸到地板；近處山勢的位移和遠方平緩的天際線共同交代飛行方向。'
  },
  {
    id: 'cosmos', title: '宇宙穿越', english: 'Cosmic Flythrough', category: '天空與宇宙', duration: '00:10', format: '三面牆全景影像',
    short: '星點與懸浮畫框從眼前掠過，向星海深處推進。',
    concept: '以星空中的漂浮畫框作為展覽入口。觀者沿著畫框之間的空隙前進，從大小與遠近的變化感受縱深，也把觀看影像變成穿行展廊的過程。',
    description: '十秒的推進鏡頭搭配電子氛圍配樂。畫面為三面各 1920 × 1080 的牆重新安排構圖；網頁播放保留全寬比例的橫幅版本，可同時看見左、中、右三個方向。'
  },
  {
    id: 'sunset', title: '追著夕陽的路', english: 'Chasing the Sunset', category: '公路', duration: '00:24', format: '展間內平視・三面牆與地板',
    cover: 'assets/sunset-cover.jpg?v=covers1',
    short: '迎著低垂的夕陽，看路旁樹影向兩側退去。',
    concept: '夕陽像一個一直留在遠方的目的地。讓道路朝著它延伸，再以行道樹、路燈和地面標線的位移，寫出黃昏路上持續前行的感覺。',
    description: '站在展間內平視前方，夕陽落在道路盡頭。行道樹從左右兩面牆掠過，雙黃線從正面牆接到腳前的地板。影片以固定視點模擬三面牆與地板同步投影的效果，配樂以 Suno 製作。',
    assetVersion: 'interior1', youtube: 'https://www.youtube.com/watch?v=XEMVze7gQVs'
  },
  {
    id: 'highway', title: '晴日國道', english: 'Highway in Daylight', category: '公路', duration: '00:24', format: '三面牆空間模擬',
    short: '沿著白色車道線，在晴空下保持前行的視線。',
    concept: '熟悉的國道也有觀看的節奏。以車道線和前車作為穩定的參照，再讓路旁的樹木與護欄掠過，顯出直線行進時視野中央與兩側的差別。',
    description: '藍天下的多車道路向地平線收束，前方車輛維持行車視角。影片從作品的設計觀看點模擬三面牆投影，可沿著護欄觀察正面與側牆的轉折。'
  },
  {
    id: 'moon', title: '月映山寺', english: 'Moon Over the Temple', category: '靜觀', duration: '02:30', format: '三面牆全景影像',
    cover: 'assets/moon-cover.jpg?v=covers1',
    short: '山寺一盞暖燈，陪伴月色中的《心經》經文。',
    concept: '以夜色為閱讀留下安靜的背景。山寺的燈火和遠處的月亮分居畫面兩側，視線可停在中央的經文，也可在字句之間移向山水。',
    description: '青藍山色沿著橫幅鋪開，寺院、月輪與觀音意象分布在兩翼。《般若波羅蜜多心經》的文字依序顯現，透過寬幅構圖安排文字與景物的位置。'
  },
  {
    id: 'lotus', title: '雲起蓮開', english: 'Clouds Rise, Lotus Blooms', category: '靜觀', duration: '02:29', format: '三面牆全景影像',
    cover: 'assets/lotus-cover.jpg?v=covers1',
    short: '在金綠色的山水長卷裡，逐句閱讀《心經》。',
    concept: '將讀經的時間留給每一句文字。以橫向展開的山水和蓮座構成觀看空間，讓經文在中央浮現，讀者可隨字句停留，也可轉向兩側觀看細節。',
    description: '金綠色山水環繞中央的經文，兩側安置菩薩、蓮座與流雲。文字與背景動態分層呈現，在三面牆的尺度上形成一幅隨時間展開的長卷。'
  }
];
