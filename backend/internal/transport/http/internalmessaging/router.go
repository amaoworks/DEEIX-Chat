package internalmessaging

import "github.com/gin-gonic/gin"

func (m *Module) RegisterRoutes(authRequired *gin.RouterGroup) {
	group := authRequired.Group("/internal-messaging")
	group.GET("/status", m.Handler.Status)
	group.GET("/conversations", m.Handler.ListConversations)
	group.GET("/messages/search", m.Handler.SearchMessages)
	group.GET("/users", m.Handler.ListUsers)
	group.GET("/users/:publicID/messages", m.Handler.History)
	group.POST("/users/:publicID/messages", m.Handler.Send)
	group.POST("/users/:publicID/messages/reply", m.Handler.Reply)
	group.POST("/users/:publicID/files", m.Handler.SendFile)
	group.PUT("/messages/:mid", m.Handler.Edit)
	group.DELETE("/messages/:mid", m.Handler.Delete)
	group.GET("/messages/:mid/file", m.Handler.DownloadFile)
	group.PUT("/users/:publicID/read", m.Handler.MarkRead)
	group.PATCH("/users/:publicID/preferences", m.Handler.SetConversationPreferences)
	group.GET("/events", m.Handler.Events)
}

func (m *Module) RegisterAdminRoutes(adminGroup *gin.RouterGroup) {
	adminGroup.GET("/internal-messaging/status", m.Handler.AdminStatus)
}
