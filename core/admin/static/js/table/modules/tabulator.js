/**
 * Tabulator configuration and initialization
 */
import { statusFormatter, dateFormatter, actionButtons, pageTypeFormatter, publishDateFormatter } from "./utils.js"

export function initializeTable(contentType, modalManager) {
    // i18n helper for JS-generated table strings.
    const t = (key, params) => (window.I18N ? window.I18N.t(key, params) : key)

    // Base columns that are common to both posts and pages
    const baseColumns = [
        {
            formatter: "rowSelection",
            titleFormatter: "rowSelection",
            hozAlign: "center",
            headerSort: false,
            width: 30,
        },
        {
            title: t("table_title"),
            field: "title",
            sorter: "string",
            headerFilter: "input",
            headerFilterPlaceholder: t("table_searchTitles"),
            widthGrow: 3,
            formatter: function (cell) {
                return `<a href="/aether/${contentType}/edit/${cell.getRow().getData().id}">${cell.getValue()}</a>`
            },
            responsive: 0,
            minWidth: 200,
        },
        {
            title: t("table_author"),
            field: "author",
            sorter: "string",
            headerFilter: "input",
            headerFilterPlaceholder: t("table_filterAuthor"),
            responsive: 4,
            minWidth: 150,
        },
        {
            title: t("table_status"),
            field: "status",
            sorter: "string",
            formatter: statusFormatter,
            headerFilter: "list",
            headerFilterParams: {
                values: { "": t("table_all"), published: t("table_published"), draft: t("table_draft") },
            },
            headerFilterPlaceholder: t("table_filterStatus"),
            responsive: 3,
            minWidth: 100,
        },
        {
            title: t("table_date"),
            field: "updatedAt",
            formatter: publishDateFormatter,
            responsive: 5,
            minWidth: 100,
        },
        {
            title: t("table_actions"),
            formatter: (cell) => actionButtons(cell, contentType),
            headerSort: false,
            responsive: 1,
            minWidth: 200,
        },
    ]

    // Add page-specific columns if this is a pages table
    if (contentType === "pages") {
        // Insert page type column before the Actions column
        baseColumns.splice(-1, 0, {
            title: t("table_type"),
            field: "pageType",
            sorter: "string",
            formatter: pageTypeFormatter,
            headerFilter: "list",
            headerFilterParams: {
                values: { "": t("table_all"), normal: t("table_normal"), custom: t("table_custom") },
            },
            headerFilterPlaceholder: t("table_filterType"),
            width: 100,
            responsive: 3,
        })
    }

    // Initialize Tabulator
    const mdFilesTable = new Tabulator("#md-files-table", {
        ajaxURL: `/aether/table/${contentType}`,
        ajaxConfig: {
            method: "GET",
            headers: {
                Accept: "application/json",
            },
        },
        ajaxParams: {
            format: "json",
        },
        pagination: true,
        paginationMode: "remote",
        paginationSize: 10,
        paginationSizeSelector: [5, 10, 20, 50, 100],
        paginationCounter: function (start, end, total) {
            return t("table_showing", { start, end, total })
        },
        responsiveLayout: "hide",
        layout: "fitColumns",
        // Fixed height + non-virtual vertical rendering. Without these, Tabulator
        // v6 can get into a resize ⇄ render feedback loop
        // (adjustTableSize → tableResized → redraw → rerenderRows → _virtualRenderFill
        //  → resize → …) which throws "Maximum call stack size exceeded" and leaves
        // the table stuck on "Loading". Pagination is 10 rows, so vertical virtual
        // rendering is unnecessary anyway.
        height: "calc(100vh - 320px)",
        renderVertical: "basic",
        selectable: true,
        placeholder: t(contentType === "pages" ? "table_noPagesFound" : "table_noPostsFound"),
        initialSort: [{ column: "updatedAt", dir: "desc" }],
        // Never leave the table spinning forever if the data request fails.
        ajaxError: function (error) {
            console.error("Table data load failed:", error)
            if (this && typeof this.alert === "function") {
                this.alert("加载表格数据失败：" + (error && error.message ? error.message : "请刷新重试"))
            }
        },
        columns: baseColumns,
    })

    // Add event listeners for delete buttons
    mdFilesTable.on("dataProcessed", function () {
        document.querySelectorAll(".delete-button").forEach((button) => {
            button.addEventListener("click", function (e) {
                e.stopPropagation() // Prevent row selection
                const id = this.getAttribute("data-id")
                const status = this.getAttribute("data-status")
                modalManager.showDeleteModal(id, status)
            })
        })
    })

    return mdFilesTable
}
