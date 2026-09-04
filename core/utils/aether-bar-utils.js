/**
 * Creates HTML for the Aether bar to be injected directly into a page
 * @param {Object} options Aether bar configuration options
 * @param {Object} options.userData Current user data
 * @param {Object} options.contentData Info about current content being viewed (optional)
 * @param {string} options.environment Environment name (development, staging, production)
 * @param {string} [options.language] UI language ('zh' or 'en'); defaults to 'zh'
 * @returns {<string>} HTML, CSS and JavaScript for the Aether bar
 */

// Localized labels for the floating admin bar (frontend, logged-in).
const I18N = {
    zh: {
        edit: "编辑",
        allItems: (type) => (type === "page" ? "所有页面" : "所有文章"),
        settings: "设置",
        users: "用户",
        media: "媒体",
        dashboard: "仪表盘",
        contentInfo: "内容信息",
        fieldId: "编号",
        fieldCreated: "创建于",
        fieldUpdated: "更新于",
        fieldAuthor: "作者",
        fieldStatus: "状态",
        fieldSlug: "别名",
        na: "无",
        logOut: "退出登录",
        viewPageInfo: "查看页面信息",
        pageLoadTime: "页面加载时间",
        env: { development: "开发环境", production: "生产环境", staging: "预发环境", testing: "测试环境" },
        role: { admin: "管理员", editor: "编辑" },
        noUsername: "[未登录]",
        noRole: "[无角色]",
        openBracket: "（",
        closeBracket: "）",
    },
    en: {
        edit: "Edit",
        allItems: (type) => (type === "page" ? "All pages" : "All posts"),
        settings: "Settings",
        users: "Users",
        media: "Media",
        dashboard: "Dashboard",
        contentInfo: "Content Information",
        fieldId: "ID",
        fieldCreated: "Created",
        fieldUpdated: "Updated",
        fieldAuthor: "Author",
        fieldStatus: "Status",
        fieldSlug: "Slug",
        na: "N/A",
        logOut: "Log out",
        viewPageInfo: "View page info",
        pageLoadTime: "Page load time",
        env: { development: "development", production: "production", staging: "staging", testing: "testing" },
        role: { admin: "admin", editor: "editor" },
        noUsername: "[No Username]",
        noRole: "[No Role]",
        openBracket: " (",
        closeBracket: ")",
    },
}

export function createAetherBarHtml(options = {}) {
    const { userData, contentData, environment } = options
    const language = options.language === "en" ? "en" : "zh"
    const L = I18N[language] || I18N.zh

    // Determine if we're on a content page
    const isContentPage = !!(contentData?.type && contentData?.id)

    // Localized labels used throughout the template
    const envLabel = L.env[environment] || environment
    const username = userData?.username || L.noUsername
    const roleLabel = L.role[userData?.role] || L.noRole
    const userInfoText = `${username}${L.openBracket}${roleLabel}${L.closeBracket}`

    // Create a data object to pass to the frontend
    const aetherBarData = {
        user: userData || {},
        contentType: contentData?.type || "",
        contentId: contentData?.id || "",
        environment: environment || "development",
        metadata: contentData?.metadata || {},
        isContentPage: isContentPage,
        lang: language,
    }

    // Create content-specific buttons if we're on a content page
    let contentButtons = ""
    if (isContentPage) {
        contentButtons = `
        <a href="/aether/${contentData.type}s/edit/${contentData.id}" class="aether-btn">
          <i class="edit-icon"></i>
          ${L.edit}
        </a>
        <a href="/aether/table/${contentData.type}s" class="aether-btn">
          <i class="list-icon"></i>
          ${L.allItems(contentData.type)}
        </a>
      `
    }

    // Create admin-only buttons (conditional display based on role will be handled by JS)
    const adminButtons = `
      <a href="/aether/settings" class="aether-btn aether-only">
        <i class="settings-icon"></i>
        ${L.settings}
      </a>
      <a href="/aether/users" class="aether-btn aether-only">
        <i class="users-icon"></i>
        ${L.users}
      </a>
    `

    // Create the minimal but complete HTML structure
    return {
        html: `
        <!-- Aether Bar Structure -->
        <div class="aether-bar-horizontal${environment ? ` aether-env-${environment}` : ""}">
          <div class="aether-env-user-info">
            <!-- Environment indicator -->
            ${environment ? `<span class="aether-environment-badge">${envLabel}</span>` : ""}

            <!-- User info -->
            <span class="aether-user-info">
              <i class="admin-icon"></i>
              <span id="username-display">${userInfoText}</span>
            </span>
            </div>

          <!-- Actions menu -->
          <div class="aether-actions" id="aether-actions">
            <!-- Content-specific buttons -->
            ${contentButtons}

            <!-- Standard buttons -->
            <a href="/aether/media" class="aether-btn aether-media-btn">
              <i class="media-icon"></i>
              ${L.media}
            </a>
            <a href="/aether" class="aether-btn">
              <i class="dashboard-icon"></i>
              ${L.dashboard}
            </a>

            <!-- Admin-only buttons -->
            ${adminButtons}
          </div>

          <!-- Performance indicator -->
          <div class="aether-performance">
            <span class="bd-perf-indicator" title="${L.pageLoadTime}"></span>
          </div>

          <!-- Info button - only shown for content pages -->
          ${
              isContentPage
                  ? `
          <button class="aether-info-toggle" title="${L.viewPageInfo}">
            <i class="info-icon"></i>
          </button>
          `
                  : ""
          }

          <!-- Logout button -->
          <a href="/aether/logout" class="aether-logout-btn" title="${L.logOut}">
            <i class="logout-icon"></i>
          </a>
        </div>

        <!-- Information panel - only for content pages -->
        ${
            isContentPage
                ? `
        <div class="aether-info-panel">
          <h4>${L.contentInfo}</h4>
          <ul>
            <li><strong>${L.fieldId}:</strong> ${contentData.id}</li>
            ${
                contentData.metadata
                    ? `
            <li><strong>${L.fieldCreated}:</strong> ${
                contentData.metadata.createdAt ? new Date(contentData.metadata.createdAt).toLocaleDateString() : L.na
            }</li>
            <li><strong>${L.fieldUpdated}:</strong> ${
                contentData.metadata.updatedAt ? new Date(contentData.metadata.updatedAt).toLocaleDateString() : L.na
            }</li>
            <li><strong>${L.fieldAuthor}:</strong> ${contentData.metadata.author || L.na}</li>
            <li><strong>${L.fieldStatus}:</strong> ${contentData.metadata.status || L.na}</li>
            <li><strong>${L.fieldSlug}:</strong> ${contentData.metadata.slug || L.na}</li>
            `
                    : ""
            }
          </ul>
          <div class="aether-info-close">×</div>
        </div>
        `
                : ""
        }

        <script>window.aetherBarData = ${JSON.stringify(aetherBarData)};</script>
        <link rel="stylesheet" href="/assets/css/aether-bar.css">
        <script src="/assets/js/aether-bar.js"></script>
      `,
    }
}
