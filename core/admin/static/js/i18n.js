/**
 * Admin i18n — client-side language framework for the Aether admin UI.
 *
 * - Dictionaries for zh (中文) and en (English).
 * - I18N.t(key, params) — get a translated string (params are {name} tokens).
 * - I18N.apply() — translate the DOM using data-i18n attributes:
 *      data-i18n              → element textContent
 *      data-i18n-placeholder  → input placeholder
 *      data-i18n-title        → element title attribute
 * - I18N.setLang(lang) — switch language live and re-apply.
 *
 * The current language is resolved in this order:
 *   1. window.__ADMIN_LANG            (injected server-side, e.g. login page)
 *   2. meta[name="admin-lang"]        (injected into the admin head)
 *   3. GET /api/settings → data.uiLanguage   (authenticated; all admin pages)
 *   4. default "zh"
 */
(function () {
    "use strict"

    const messages = {
        zh: {
            // common
            save: "保存",
            cancel: "取消",
            ok: "确定",
            close: "关闭",
            delete: "删除",
            publish: "发布",
            draft: "草稿",
            setToDraft: "转为草稿",
            edit: "编辑",
            add: "添加",
            logout: "退出登录",
            viewSite: "查看站点",
            apply: "应用",
            reset: "重置",
            export: "导出",
            processing: "处理中…",
            loading: "加载中…",
            search: "搜索",
            manage: "管理",
            addNew: "新增",
            operations: "操作",
            confirm: "确认",
            select: "选择",
            remove: "移除",

            // nav / sidebar
            nav_dashboard: "仪表盘",
            nav_posts: "文章",
            nav_pages: "页面",
            nav_knowledgeGraph: "知识图谱",
            nav_tagCloud: "标签云",
            nav_media: "媒体",
            nav_themes: "主题",
            nav_users: "用户",
            nav_settings: "设置",

            // login
            login_title: "登录 | Aether",
            login_welcome: "欢迎回来",
            login_username: "用户名",
            login_password: "密码",
            login_submit: "登录 →",
            login_footer: "Aether CMS by teacherGeng",
            login_error_generic: "用户名或密码错误",

            // dashboard
            dashboard_title: "仪表盘",
            dashboard_quickActions: "快捷操作",
            dashboard_addPost: "新建文章",
            dashboard_addPage: "新建页面",
            dashboard_uploadMedia: "上传媒体",
            dashboard_updateSettings: "更新设置",
            dashboard_siteInfo: "站点信息",
            dashboard_posts: "文章",
            dashboard_pages: "页面",
            dashboard_users: "用户",

            // table page
            table_manage: "管理",
            table_addPost: "新增文章",
            table_addPage: "新增页面",
            table_exportCsv: "导出 CSV",
            table_bulkActions: "批量操作",
            table_processing: "处理中…",

            // settings page
            settings_siteSettings: "站点设置",
            settings_general: "常规",
            settings_appearance: "外观",
            settings_content: "内容",
            settings_advanced: "高级",
            settings_menu: "菜单",
            settings_staticSite: "静态站点",
            settings_uiLanguage: "界面语言",
            settings_uiLanguageDesc: "选择后台管理界面的显示语言。",
            settings_lang_zh: "中文",
            settings_lang_en: "English",

            settings_siteInfo: "站点信息",
            settings_siteTitle: "站点标题",
            settings_siteTitleHelp: "您站点的名称，显示在页眉和浏览器标签页中。",
            settings_siteDescription: "站点描述",
            settings_siteDescriptionHelp: "您站点的简短描述，可能被搜索引擎使用。",
            settings_siteUrl: "站点 URL",
            settings_siteUrlHelp: "您站点的完整 URL（例如 https://example.com）。",

            settings_adminContact: "管理员联系",
            settings_adminEmail: "管理员邮箱",
            settings_adminEmailHelp: "用于系统通知和密码恢复。",

            settings_theme: "主题",
            settings_activeTheme: "当前主题",
            settings_activeThemeHelp: "选择前台站点使用的主题。",
            settings_themePreview: "主题预览",
            settings_customization: "自定义",
            settings_siteLogo: "站点 Logo",
            settings_siteLogoHelp: "您站点的 Logo（推荐尺寸: 200×60 像素）。",
            settings_siteIcon: "站点图标 (Favicon)",
            settings_siteIconHelp: "您站点的收藏夹图标（推荐尺寸: 32×32 像素）。",
            settings_selectLogo: "选择 Logo",

            settings_posts: "文章",
            settings_postsPerPage: "每页文章数",
            settings_postsPerPageHelp: "博客每页显示的文章数量。",
            settings_defaultPostAuthor: "默认文章作者",
            settings_defaultPostAuthorHelp: "新建文章的默认作者。",

            settings_comments: "评论",
            settings_enableComments: "启用评论",
            settings_enableCommentsHelp: "允许用户对您的文章发表评论。",
            settings_commentModeration: "评论审核",
            settings_commentModerationHelp: "选择评论应如何审核。",

            settings_performance: "性能",
            settings_enableCaching: "启用页面缓存",
            settings_enableCachingHelp: "缓存页面以提升性能。",
            settings_cacheDuration: "缓存时长（分钟）",
            settings_cacheDurationHelp: "缓存页面应保留多长时间（分钟）。",

            settings_customCode: "自定义代码",
            settings_headerCode: "页头代码",
            settings_headerCodeHelp: "添加到站点 <code>head</code> 区块的自定义 HTML。",
            settings_footerCode: "页脚代码",
            settings_footerCodeHelp: "添加到站点 <code>body</code> 闭合标签前的自定义 HTML。",

            settings_navigationMenu: "导航菜单",
            settings_navigationMenuDesc: "配置站点导航菜单，更改将应用到当前主题。",

            settings_staticGenerator: "静态站点生成器",
            settings_staticGeneratorDesc: "生成可部署到任何 Web 托管服务的站点静态版本。",
            settings_outputDir: "输出目录",
            settings_outputDirHelp: "静态站点生成的目录。",
            settings_baseUrl: "基础 URL",
            settings_baseUrlHelp: "站点的基础 URL（例如 \"/\" 或 \"/blog/\"）。",
            settings_useCleanUrls: "使用简洁 URL",
            settings_useCleanUrlsHelp: "使用 目录/index.html 结构而非 .html 文件。",
            settings_generateStatic: "生成静态站点",

            settings_save: "保存设置",
            settings_reset: "重置更改",
            settings_saved: "设置已保存",
            settings_savedMsg: "您的设置已成功保存。",

            // media modal (settings)
            settings_selectMedia: "选择媒体",
            settings_searchMedia: "搜索媒体…",
            settings_noMedia: "未找到媒体。请在媒体库中上传文件。",
            settings_gotoMedia: "前往媒体库",
            settings_cancel: "取消",
            settings_select: "选择",

            // knowledge graph (admin)
            graph_title: "知识图谱",

            // tag cloud (admin)
            tagcloud_title: "标签云",

            // content table (JS-generated)
            table_title: "标题",
            table_author: "作者",
            table_status: "状态",
            table_date: "日期",
            table_actions: "操作",
            table_type: "类型",
            table_searchTitles: "搜索标题…",
            table_filterAuthor: "筛选作者…",
            table_filterStatus: "筛选状态…",
            table_filterType: "筛选类型…",
            table_all: "全部",
            table_published: "已发布",
            table_draft: "草稿",
            table_normal: "普通",
            table_custom: "自定义",
            table_noPostsFound: "未找到文章！",
            table_noPagesFound: "未找到页面！",
            table_showing: "显示 {start} - {end}，共 {total} 行",
            // table suffix (in the title)
            table_suffixPosts: "文章",
            table_suffixPages: "页面",

            // media library
            media_library: "媒体库",
            media_search: "搜索媒体…",
            media_allTypes: "全部类型",
            media_images: "图片",
            media_documents: "文档",
            media_newest: "最新优先",
            media_oldest: "最早优先",
            media_nameAZ: "名称 A-Z",
            media_size: "大小",
            media_upload: "上传媒体",
            media_chooseFiles: "选择文件",
            media_orDrag: "或拖拽到此处",
            media_noFilesSelected: "未选择文件",
            media_defaultAlt: "默认替代文本",
            media_altPlaceholder: "对图片的简短描述",
            media_altHelp: "将应用于所有上传的图片。之后可单独编辑。",
            media_uploadFiles: "上传文件",
            media_items: "项",
            media_selected: "已选中",
            media_deselectAll: "取消全选",
            media_deleteSelected: "删除选中",
            media_noMediaFound: "未找到媒体",
            media_noMediaDesc: "上传媒体文件以开始使用。",
            media_loading: "加载媒体…",
            media_details: "媒体详情",
            media_filename: "文件名",
            media_altText: "替代文本",
            media_altDesc: "描述此图片",
            media_altHelp2: "有助于无障碍访问和 SEO。",
            media_caption: "标题说明",
            media_captionPlaceholder: "图片的可选说明",
            media_typeLabel: "类型",
            media_sizeLabel: "大小",
            media_dimensions: "尺寸",
            media_uploaded: "上传时间",
            media_usage: "使用情况",
            media_notUsed: "当前未在任何文章或页面中使用。",
            media_saveChanges: "保存更改",
            media_delete: "删除",

            // themes
            themes_title: "主题管理",
            themes_upload: "上传主题",
            themes_installed: "已安装主题",
            themes_marketplace: "主题市场",
            themes_choosePackage: "选择主题包",
            themes_orDrag: "或拖拽到此处",
            themes_noPackage: "未选择主题包",
            themes_packageHelp: "主题包必须为 .zip 格式，并包含有效的 theme.json 文件。",
            themes_noPreview: "无预览",
            themes_active: "使用中",
            themes_updateAvailable: "有更新",
            themes_noThemes: "未找到主题",
            themes_noThemesDesc: "上传主题包以开始使用。",
            themes_search: "搜索主题…",
            themes_allCategories: "全部分类",
            themes_recentlyUpdated: "最近更新",
            themes_name: "名称",
            themes_version: "版本",
            themes_refresh: "刷新",
            themes_loading: "加载主题…",
            themes_loadingMarketplace: "正在从市场加载主题…",
            themes_loadFailed: "加载主题失败，请重试。",
            themes_retry: "重试",
            themes_noFound: "未找到主题",
            themes_noFoundDesc: "请尝试调整搜索或筛选条件。",
            themes_details: "主题详情",
            themes_author: "作者",
            themes_features: "功能",
            themes_tags: "标签",
            themes_activate: "启用主题",
            themes_update: "更新主题",
            themes_delete: "删除主题",
            themes_confirmDelete: "确认删除主题",
            themes_confirmDeleteBody: "您确定要删除此主题吗？此操作无法撤销。",
            themes_notInstalled: "未安装",
            themes_installedBadge: "已安装",
            themes_viewDetails: "查看详情",
            themes_whatsNew: "此更新的新内容",
            themes_showMore: "显示更多",
            themes_lastUpdated: "最后更新",
            themes_license: "许可",
            themes_install: "安装主题",
            themes_checkingUpdates: "正在检查更新…",
            themes_updateAvailable2: "此主题有新版本可用。",
            themes_currentVersion: "当前版本",
            themes_latestFeatures: "查看此更新的最新功能和改进。",
            themes_updatedFrom: "从 v{from} 更新到 v{to}",
            themes_latest: "最新",
            themes_installedVer: "已安装",

            // users
            users_title: "用户管理",
            users_addNew: "新增用户",
            users_editUser: "编辑用户",
            users_passwordNew: "新用户需要设置密码。",
            users_username: "用户名",
            users_usernameHelp: "用户名之后无法更改。",
            users_email: "邮箱",
            users_password: "密码",
            users_passwordHelp: "留空以保留当前密码。",
            users_role: "角色",
            users_administrator: "管理员",
            users_editor: "编辑",
            users_saveUser: "保存用户",
            users_search: "搜索用户…",
            users_created: "创建时间",
            users_actions: "操作",
            users_loading: "加载用户…",
            users_noUsers: "未找到用户",
            users_noUsersDesc: "添加新用户以管理您的站点。",
            users_confirmDelete: "确认删除用户",
            users_confirmDeleteBody: "您确定要删除此用户吗？此操作无法撤销。",
            users_warning: "警告",
            users_deleteWarning: "您不能删除最后一个管理员或您自己的账号。",

            // menu editor component
            menu_globalEditor: "全局菜单编辑器",
            menu_shared: "此菜单在所有主题间共享。",
            menu_dragHint: "拖拽菜单项以重新排序。使用缩进/减少缩进按钮创建层级。点击可编辑属性。",
            menu_addItem: "添加菜单项",
            menu_save: "保存菜单",
            menu_noItems: "未找到菜单项。请使用上方按钮添加。",
            menu_editItem: "编辑菜单项",
            menu_menuTitle: "标题",
            menu_url: "URL",
            menu_urlHelp: "使用相对 URL（如 \"/page/about\"）或绝对 URL（如 \"https://example.com\"）。",
            menu_parentItem: "父级项",
            menu_noneTopLevel: "无（顶层）",
            menu_openIn: "打开方式",
            menu_sameWindow: "同一窗口",
            menu_newWindow: "新窗口",
            menu_cssClass: "CSS 类（可选）",
            menu_delete: "删除",
            menu_saveItem: "保存",
            menu_confirmDelete: "确认删除",
            menu_confirmDeleteBody: "您确定要删除此菜单项吗？此操作无法撤销。",
            menu_subDeleteWarning: "此项包含的子项也将被删除。",
            menu_indent: "缩进（设为子项）",
            menu_outdent: "减少缩进（上移一级）",
            menu_edit: "编辑",

            // editor (post/page edit page)
            editor_addNewPost: "新增文章",
            editor_addNewPage: "新增页面",
            editor_editPost: "编辑文章",
            editor_editPage: "编辑页面",
            editor_saveDraft: "保存草稿",
            editor_update: "更新",
            editor_revertDraft: "还原为草稿",
            editor_title: "标题",
            editor_enterTitle: "输入标题",
            editor_subtitle: "副标题",
            editor_enterSubtitle: "输入副标题或标语（可选）",
            editor_content: "内容",
            editor_tabEditor: "编辑",
            editor_tabPreview: "预览",
            editor_writeContent: "在此输入内容…",
            editor_toggleSidebar: "打开/关闭侧栏 (Ctrl+Shift+S)",
            editor_toggleFullscreen: "切换全屏",
            editor_toggleSideBySide: "切换并排视图",
            editor_publishingOptions: "发布选项",
            editor_closeSidebar: "关闭侧栏",
            editor_status: "状态",
            editor_draft: "草稿",
            editor_published: "已发布",
            editor_slug: "别名",
            editor_slugHelp: "标题的 URL 友好版本。",
            editor_pageSettings: "页面设置",
            editor_pageType: "页面类型",
            editor_normal: "普通",
            editor_customTemplate: "自定义模板",
            editor_pageTypeHelp: "普通页面使用标准页面布局。自定义页面使用主题 \"custom\" 目录中的模板文件。",
            editor_parentPage: "父级页面",
            editor_noneTopLevel: "无（顶层）",
            editor_parentPageHelp: "选择父级页面以创建嵌套 URL。例如父级为 \"docs\"，该页面将在 /docs/[slug] 访问。",
            editor_seoSettings: "SEO 设置",
            editor_metaDescription: "元描述",
            editor_metaDescPlaceholder: "用于搜索引擎的描述…",
            editor_metaDescHelp: "推荐长度 150-160 字符，用于搜索结果。",
            editor_media: "媒体",
            editor_featuredImage: "特色图片",
            editor_setFeaturedImage: "设置特色图片",
            editor_mediaHelpTip: "使用编辑器工具栏中的图片按钮（🖼️）在内容中插入图片。",
            editor_relatedPosts: "相关文章",
            editor_selectRelated: "选择与此内容一起显示的相关文章",
            editor_noRelated: "未选择相关文章",
            editor_addRelated: "添加相关文章",
            editor_searchPosts: "搜索文章…",
            editor_upTo5Related: "选择最多 5 篇相关文章推荐给读者。",
            editor_additionalSettings: "其它设置",
            editor_category: "分类",
            editor_addCategory: "添加分类…",
            editor_add: "添加",
            editor_addCategoryHelp: "添加一个主分类以组织内容。",
            editor_tags: "标签",
            editor_recommendTags: "✨ 推荐标签",
            editor_addTag: "添加标签…",
            editor_addTagHelp: "添加多个标签以帮助用户找到相关内容。",
            editor_excerpt: "摘要",
            editor_excerptPlaceholder: "简要摘要…",
            editor_excerptHelp: "内容的简短摘要。",
            editor_author: "作者",
            editor_distractionFree: "无干扰编辑",
            editor_exitFullscreen: "退出全屏",
        },

        en: {
            // common
            save: "Save",
            cancel: "Cancel",
            ok: "OK",
            close: "Close",
            delete: "Delete",
            publish: "Publish",
            draft: "Draft",
            setToDraft: "Set to Draft",
            edit: "Edit",
            add: "Add",
            logout: "Logout",
            viewSite: "View Site",
            apply: "Apply",
            reset: "Reset",
            export: "Export",
            processing: "Processing…",
            loading: "Loading…",
            search: "Search",
            manage: "Manage",
            addNew: "Add New",
            operations: "Operations",
            confirm: "Confirm",
            select: "Select",
            remove: "Remove",

            // nav / sidebar
            nav_dashboard: "Dashboard",
            nav_posts: "Posts",
            nav_pages: "Pages",
            nav_knowledgeGraph: "Knowledge Graph",
            nav_tagCloud: "Tag Cloud",
            nav_media: "Media",
            nav_themes: "Themes",
            nav_users: "Users",
            nav_settings: "Settings",

            // login
            login_title: "Login | Aether",
            login_welcome: "Welcome back",
            login_username: "Username",
            login_password: "Password",
            login_submit: "Log In →",
            login_footer: "Aether CMS by teacherGeng",
            login_error_generic: "Invalid username or password",

            // dashboard
            dashboard_title: "Dashboard",
            dashboard_quickActions: "Quick Actions",
            dashboard_addPost: "Add New Post",
            dashboard_addPage: "Add New Page",
            dashboard_uploadMedia: "Upload Media",
            dashboard_updateSettings: "Update Settings",
            dashboard_siteInfo: "Site Information",
            dashboard_posts: "Posts",
            dashboard_pages: "Pages",
            dashboard_users: "Users",

            // table page
            table_manage: "Manage",
            table_addPost: "Add New Post",
            table_addPage: "Add New Page",
            table_exportCsv: "Export CSV",
            table_bulkActions: "Bulk Actions",
            table_processing: "Processing…",

            // settings page
            settings_siteSettings: "Site Settings",
            settings_general: "General",
            settings_appearance: "Appearance",
            settings_content: "Content",
            settings_advanced: "Advanced",
            settings_menu: "Menu",
            settings_staticSite: "Static Site",
            settings_uiLanguage: "UI Language",
            settings_uiLanguageDesc: "Choose the display language of the admin interface.",
            settings_lang_zh: "中文",
            settings_lang_en: "English",

            settings_siteInfo: "Site Information",
            settings_siteTitle: "Site Title",
            settings_siteTitleHelp: "The name of your site, displayed in the header and browser tab.",
            settings_siteDescription: "Site Description",
            settings_siteDescriptionHelp: "A short description of your site. This may be used by search engines.",
            settings_siteUrl: "Site URL",
            settings_siteUrlHelp: 'The full URL of your site (e.g., https://example.com).',

            settings_adminContact: "Admin Contact",
            settings_adminEmail: "Admin Email",
            settings_adminEmailHelp: "Used for system notifications and password recovery.",

            settings_theme: "Theme",
            settings_activeTheme: "Active Theme",
            settings_activeThemeHelp: "Select the theme for your site's front end.",
            settings_themePreview: "Theme Preview",
            settings_customization: "Customization",
            settings_siteLogo: "Site Logo",
            settings_siteLogoHelp: "Your site logo (recommended size: 200×60 pixels).",
            settings_siteIcon: "Site Icon (Favicon)",
            settings_siteIconHelp: "Your site favicon (recommended size: 32×32 pixels).",
            settings_selectLogo: "Select Logo",

            settings_posts: "Posts",
            settings_postsPerPage: "Posts Per Page",
            settings_postsPerPageHelp: "Number of posts to display per page on the blog.",
            settings_defaultPostAuthor: "Default Post Author",
            settings_defaultPostAuthorHelp: "Default author for new posts.",

            settings_comments: "Comments",
            settings_enableComments: "Enable comments",
            settings_enableCommentsHelp: "Allow users to leave comments on your posts.",
            settings_commentModeration: "Comment Moderation",
            settings_commentModerationHelp: "Choose how comments should be moderated.",

            settings_performance: "Performance",
            settings_enableCaching: "Enable page caching",
            settings_enableCachingHelp: "Cache pages to improve performance.",
            settings_cacheDuration: "Cache Duration (in minutes)",
            settings_cacheDurationHelp: "How long cached pages should be stored (in minutes).",

            settings_customCode: "Custom Code",
            settings_headerCode: "Header Code",
            settings_headerCodeHelp: 'Custom HTML code to add to the <code>head</code> section of your site.',
            settings_footerCode: "Footer Code",
            settings_footerCodeHelp: 'Custom HTML code to add before the closing <code>body</code> tag.',

            settings_navigationMenu: "Navigation Menu",
            settings_navigationMenuDesc: "Configure the navigation menu for your site. Changes will be applied to the active theme.",

            settings_staticGenerator: "Static Site Generator",
            settings_staticGeneratorDesc: "Generate a static version of your site that can be deployed to any web hosting service.",
            settings_outputDir: "Output Directory",
            settings_outputDirHelp: "The directory where the static site will be generated.",
            settings_baseUrl: "Base URL",
            settings_baseUrlHelp: 'The base URL for the site (e.g., "/" or "/blog/").',
            settings_useCleanUrls: "Use clean URLs",
            settings_useCleanUrlsHelp: "Use directory/index.html pattern instead of .html files.",
            settings_generateStatic: "Generate Static Site",

            settings_save: "Save Settings",
            settings_reset: "Reset Changes",
            settings_saved: "Settings Saved",
            settings_savedMsg: "Your settings have been saved successfully.",

            // media modal (settings)
            settings_selectMedia: "Select Media",
            settings_searchMedia: "Search media...",
            settings_noMedia: "No media found. Upload media files in the Media Library.",
            settings_gotoMedia: "Go to Media Library",
            settings_cancel: "Cancel",
            settings_select: "Select",

            // knowledge graph (admin)
            graph_title: "Knowledge Graph",

            // tag cloud (admin)
            tagcloud_title: "Tag Cloud",

            // content table (JS-generated)
            table_title: "Title",
            table_author: "Author",
            table_status: "Status",
            table_date: "Date",
            table_actions: "Actions",
            table_type: "Type",
            table_searchTitles: "Search titles...",
            table_filterAuthor: "Filter author...",
            table_filterStatus: "Filter status...",
            table_filterType: "Filter type...",
            table_all: "All",
            table_published: "Published",
            table_draft: "Draft",
            table_normal: "Normal",
            table_custom: "Custom",
            table_noPostsFound: "No posts found!",
            table_noPagesFound: "No pages found!",
            table_showing: "Showing {start} - {end} of {total} rows",
            // table suffix (in the title)
            table_suffixPosts: "Posts",
            table_suffixPages: "Pages",

            // media library
            media_library: "Media Library",
            media_search: "Search media...",
            media_allTypes: "All Types",
            media_images: "Images",
            media_documents: "Documents",
            media_newest: "Newest First",
            media_oldest: "Oldest First",
            media_nameAZ: "Name A-Z",
            media_size: "Size",
            media_upload: "Upload Media",
            media_chooseFiles: "Choose files",
            media_orDrag: "or drag them here",
            media_noFilesSelected: "No files selected",
            media_defaultAlt: "Default Alt Text",
            media_altPlaceholder: "Brief description of image(s)",
            media_altHelp: "Will be applied to all uploaded images. You can edit individual images later.",
            media_uploadFiles: "Upload Files",
            media_items: "items",
            media_selected: "selected",
            media_deselectAll: "Deselect All",
            media_deleteSelected: "Delete Selected",
            media_noMediaFound: "No Media Found",
            media_noMediaDesc: "Upload media files to get started.",
            media_loading: "Loading media...",
            media_details: "Media Details",
            media_filename: "Filename",
            media_altText: "Alt Text",
            media_altDesc: "Describe this image",
            media_altHelp2: "Helps with accessibility and SEO.",
            media_caption: "Caption",
            media_captionPlaceholder: "Optional caption for the image",
            media_typeLabel: "Type",
            media_sizeLabel: "Size",
            media_dimensions: "Dimensions",
            media_uploaded: "Uploaded",
            media_usage: "Usage",
            media_notUsed: "Not currently used in any posts or pages.",
            media_saveChanges: "Save Changes",
            media_delete: "Delete",

            // themes
            themes_title: "Theme Management",
            themes_upload: "Upload Theme",
            themes_installed: "Installed Themes",
            themes_marketplace: "Marketplace",
            themes_choosePackage: "Choose theme package",
            themes_orDrag: "or drag it here",
            themes_noPackage: "No theme package selected",
            themes_packageHelp: "Theme packages must be in .zip format and include a valid theme.json file.",
            themes_noPreview: "No Preview",
            themes_active: "Active",
            themes_updateAvailable: "Update Available",
            themes_noThemes: "No Themes Found",
            themes_noThemesDesc: "Upload a theme package to get started.",
            themes_search: "Search themes...",
            themes_allCategories: "All Categories",
            themes_recentlyUpdated: "Recently Updated",
            themes_name: "Name",
            themes_version: "Version",
            themes_refresh: "Refresh",
            themes_loading: "Loading themes...",
            themes_loadingMarketplace: "Loading themes from marketplace...",
            themes_loadFailed: "Failed to load themes. Please try again.",
            themes_retry: "Retry",
            themes_noFound: "No themes found",
            themes_noFoundDesc: "Try adjusting your search or filters.",
            themes_details: "Theme Details",
            themes_author: "Author",
            themes_features: "Features",
            themes_tags: "Tags",
            themes_activate: "Activate Theme",
            themes_update: "Update Theme",
            themes_delete: "Delete Theme",
            themes_confirmDelete: "Confirm Theme Deletion",
            themes_confirmDeleteBody: "Are you sure you want to delete this theme? This action cannot be undone.",
            themes_notInstalled: "Not Installed",
            themes_installedBadge: "Installed",
            themes_viewDetails: "View Details",
            themes_whatsNew: "What's New in this Update",
            themes_showMore: "Show More",
            themes_lastUpdated: "Last Updated",
            themes_license: "License",
            themes_install: "Install Theme",
            themes_checkingUpdates: "Checking for updates...",
            themes_updateAvailable2: "A new version of this theme is available.",
            themes_currentVersion: "Current",
            themes_latestFeatures: "View the latest features and improvements in this update.",
            themes_updatedFrom: "Updating from v{from} to v{to}",
            themes_latest: "Latest",
            themes_installedVer: "Installed",

            // users
            users_title: "User Management",
            users_addNew: "Add New User",
            users_editUser: "Edit User",
            users_passwordNew: "Password for the new user.",
            users_username: "Username",
            users_usernameHelp: "Username cannot be changed later.",
            users_email: "Email",
            users_password: "Password",
            users_passwordHelp: "Leave blank to keep current password.",
            users_role: "Role",
            users_administrator: "Administrator",
            users_editor: "Editor",
            users_saveUser: "Save User",
            users_search: "Search users...",
            users_created: "Created",
            users_actions: "Actions",
            users_loading: "Loading users...",
            users_noUsers: "No Users Found",
            users_noUsersDesc: "Add new users to manage your site.",
            users_confirmDelete: "Confirm User Deletion",
            users_confirmDeleteBody: "Are you sure you want to delete this user? This action cannot be undone.",
            users_warning: "Warning",
            users_deleteWarning: "You cannot delete the last admin user or your own account.",

            // menu editor component
            menu_globalEditor: "Global Menu Editor",
            menu_shared: "This menu is shared across all themes.",
            menu_dragHint: "Drag and drop menu items to reorder. Use the indent/outdent buttons to create hierarchies. Click to edit properties.",
            menu_addItem: "Add Menu Item",
            menu_save: "Save Menu",
            menu_noItems: "No menu items found. Add one using the button above.",
            menu_editItem: "Edit Menu Item",
            menu_menuTitle: "Title",
            menu_url: "URL",
            menu_urlHelp: 'Use relative URLs like "/page/about" or absolute URLs like "https://example.com".',
            menu_parentItem: "Parent Item",
            menu_noneTopLevel: "None (Top Level)",
            menu_openIn: "Open In",
            menu_sameWindow: "Same Window",
            menu_newWindow: "New Window",
            menu_cssClass: "CSS Class (optional)",
            menu_delete: "Delete",
            menu_saveItem: "Save",
            menu_confirmDelete: "Confirm Deletion",
            menu_confirmDeleteBody: "Are you sure you want to delete this menu item? This action cannot be undone.",
            menu_subDeleteWarning: "This item has sub-items that will also be deleted.",
            menu_indent: "Indent (make sub-item)",
            menu_outdent: "Outdent (move up level)",
            menu_edit: "Edit",

            // editor (post/page edit page)
            editor_addNewPost: "Add New Post",
            editor_addNewPage: "Add New Page",
            editor_editPost: "Edit Post",
            editor_editPage: "Edit Page",
            editor_saveDraft: "Save Draft",
            editor_update: "Update",
            editor_revertDraft: "Revert to Draft",
            editor_title: "Title",
            editor_enterTitle: "Enter title",
            editor_subtitle: "Subtitle",
            editor_enterSubtitle: "Enter subtitle or tagline (optional)",
            editor_content: "Content",
            editor_tabEditor: "Editor",
            editor_tabPreview: "Preview",
            editor_writeContent: "Write your content here...",
            editor_toggleSidebar: "Toggle Sidebar (Ctrl+Shift+S)",
            editor_toggleFullscreen: "Toggle Fullscreen Mode",
            editor_toggleSideBySide: "Toggle Side-by-Side View",
            editor_publishingOptions: "Publishing Options",
            editor_closeSidebar: "Close Sidebar",
            editor_status: "Status",
            editor_draft: "Draft",
            editor_published: "Published",
            editor_slug: "Slug",
            editor_slugHelp: "The URL-friendly version of the title.",
            editor_pageSettings: "Page Settings",
            editor_pageType: "Page Type",
            editor_normal: "Normal",
            editor_customTemplate: "Custom Template",
            editor_pageTypeHelp: 'Normal pages use the standard page layout. Custom pages use template files from the theme\'s "custom" directory.',
            editor_parentPage: "Parent Page",
            editor_noneTopLevel: "None (Top Level)",
            editor_parentPageHelp: 'Select a parent page to create nested URLs. For example, if parent is "docs", this page will be accessible at /docs/[slug].',
            editor_seoSettings: "SEO Settings",
            editor_metaDescription: "Meta Description",
            editor_metaDescPlaceholder: "Description for search engines...",
            editor_metaDescHelp: "Recommended length: 150-160 characters. Used in search results.",
            editor_media: "Media",
            editor_featuredImage: "Featured Image",
            editor_setFeaturedImage: "Set Featured Image",
            editor_mediaHelpTip: "Use the image button (🖼️) in the editor toolbar to insert images into your content.",
            editor_relatedPosts: "Related Posts",
            editor_selectRelated: "Select related posts to display with this content",
            editor_noRelated: "No related posts selected",
            editor_addRelated: "Add Related Post",
            editor_searchPosts: "Search posts...",
            editor_upTo5Related: "Select up to 5 related posts to suggest to readers.",
            editor_additionalSettings: "Additional Settings",
            editor_category: "Category",
            editor_addCategory: "Add a category...",
            editor_add: "Add",
            editor_addCategoryHelp: "Add a primary category for organizing content.",
            editor_tags: "Tags",
            editor_recommendTags: "✨ Recommend tags",
            editor_addTag: "Add a tag...",
            editor_addTagHelp: "Add multiple tags to help users find related content.",
            editor_excerpt: "Excerpt",
            editor_excerptPlaceholder: "Brief summary...",
            editor_excerptHelp: "A short summary of the content.",
            editor_author: "Author",
            editor_distractionFree: "Distraction-Free Editor",
            editor_exitFullscreen: "Exit Fullscreen",
        },
    }

    const I18N = {
        lang: "zh",
        messages,

        getCurrentLang() {
            const inline = window.__ADMIN_LANG
            if (inline && this.messages[inline]) return inline
            const meta = document.querySelector('meta[name="admin-lang"]')
            const metaVal = meta && meta.getAttribute("content")
            if (metaVal && this.messages[metaVal]) return metaVal
            return null
        },

        t(key, params) {
            const dict = this.messages[this.lang] || this.messages.zh
            let str = dict[key]
            if (str === undefined) str = this.messages.zh[key] || key
            if (params) {
                for (const [name, value] of Object.entries(params)) {
                    str = str.replace(new RegExp("\\{" + name + "\\}", "g"), value)
                }
            }
            return str
        },

        apply(root = document) {
            const translateRoot = (r) => {
                r.querySelectorAll("[data-i18n]").forEach((el) => {
                    const key = el.getAttribute("data-i18n")
                    const params = el.getAttribute("data-i18n-params")
                        ? JSON.parse(el.getAttribute("data-i18n-params"))
                        : undefined
                    el.innerHTML = this.t(key, params)
                })
                r.querySelectorAll("[data-i18n-placeholder]").forEach((el) => {
                    el.setAttribute("placeholder", this.t(el.getAttribute("data-i18n-placeholder")))
                })
                r.querySelectorAll("[data-i18n-title]").forEach((el) => {
                    el.setAttribute("title", this.t(el.getAttribute("data-i18n-title")))
                })
            }
            translateRoot(root)
            // Also translate <template> content so cloned elements are ready.
            root.querySelectorAll("template").forEach((tpl) => {
                if (tpl.content) translateRoot(tpl.content)
            })
        },

        setLang(lang) {
            if (this.messages[lang]) {
                this.lang = lang
                if (window.__ADMIN_LANG !== undefined) window.__ADMIN_LANG = lang
                const meta = document.querySelector('meta[name="admin-lang"]')
                if (meta) meta.setAttribute("content", lang)
            }
            this.apply()
        },

        async init() {
            let lang = this.getCurrentLang()

            // On authenticated admin pages the language lives in settings.json.
            if (!lang) {
                try {
                    const res = await fetch("/api/settings", { credentials: "same-origin" })
                    if (res.ok) {
                        const json = await res.json()
                        if (json.data && json.data.uiLanguage) lang = json.data.uiLanguage
                    }
                } catch (e) {
                    /* keep default */
                }
            }

            this.lang = lang && this.messages[lang] ? lang : "zh"
            this.apply()
            document.documentElement.setAttribute("lang", this.lang)
        },
    }

    window.I18N = I18N

    // Bind a global helper for inline usage and event delegation.
    window.__ = (key, params) => I18N.t(key, params)
})()
